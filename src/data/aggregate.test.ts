import { describe, it, expect } from 'vitest';
import {
  bucketByTime,
  bucketBySidecar,
  blankPartialBuckets,
  zoneMidnight,
  chooseBucketMs,
  groupTransactions,
  sortTxnGroups,
  percentile,
  transactionStats,
  logHistogram,
  type BucketResult,
  type TimeBucket,
} from './aggregate';
import type { Rec } from './types';

describe('bucketBySidecar', () => {
  // two files' hourly histograms on 2026-06-11
  const hists: Record<string, Record<string, number>>[] = [
    { '2026-06-11T00': { transaction: 10, span: 20 }, '2026-06-11T01': { transaction: 5 } },
    { '2026-06-11T00': { transaction: 3 }, '2026-06-11T05': { error: 2 } },
  ];

  it('sums histograms into 1h buckets (exact, no records needed)', () => {
    const res = bucketBySidecar(hists, null, 3_600_000)!;
    expect(res).not.toBeNull();
    expect(res.bucketMs).toBe(3_600_000);
    // hour 00 across both files: txn 13, span 20 → total 33
    const h0 = res.buckets.find((b) => b.t0 === Date.UTC(2026, 5, 11, 0))!;
    expect(h0.counts.transaction).toBe(13);
    expect(h0.counts.span).toBe(20);
    expect(h0.total).toBe(33);
    const h5 = res.buckets.find((b) => b.t0 === Date.UTC(2026, 5, 11, 5))!;
    expect(h5.counts.error).toBe(2);
  });

  it('aggregates hours into a coarser ≥1h bucket', () => {
    const res = bucketBySidecar(hists, null, 6 * 3_600_000)!;
    expect(res.bucketMs).toBe(6 * 3_600_000);
    // all hours 00–05 fall in one 6h bucket: txn 18, span 20, error 2 → 40
    expect(res.buckets[0].total).toBe(40);
  });

  it('returns null when the resolved bucket would be sub-hourly', () => {
    // a narrow window forces a small bucket → histograms can't resolve it
    const w: [number, number] = [Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 0, 15)];
    expect(bucketBySidecar(hists, w, null)).toBeNull();
  });

  it('filters out hours outside the window', () => {
    const w: [number, number] = [Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 2)];
    const res = bucketBySidecar(hists, w, 3_600_000)!;
    expect(res.domain[0]).toBe(Date.UTC(2026, 5, 11, 0)); // domain anchored at the window start
    // hour 05's error is outside the window → excluded
    expect(res.buckets.some((b) => b.counts.error)).toBe(false);
  });
});

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'event',
    ts: 0,
    channel: 'server',
    host: 'h',
    sourceKey: 'k',
    meta: {},
    name: 'x',
    rawLine: '',
    line: 0,
    ...partial,
  };
}

describe('chooseBucketMs', () => {
  it('picks 1m for an hour, 1h for a week, 1d for a long span', () => {
    expect(chooseBucketMs(3_600_000)).toBe(60_000);
    expect(chooseBucketMs(7 * 24 * 3_600_000)).toBe(3 * 3_600_000);
    expect(chooseBucketMs(365 * 24 * 3_600_000)).toBe(24 * 3_600_000);
  });
});

describe('bucketByTime', () => {
  it('buckets counts per kind on aligned boundaries', () => {
    const records = [
      rec({ kind: 'event', ts: 60_500 }),
      rec({ kind: 'event', ts: 61_000 }),
      rec({ kind: 'transaction', ts: 60_999 }),
      rec({ kind: 'span', ts: 125_000 }),
    ];
    const { buckets, bucketMs, domain } = bucketByTime(records);
    expect(bucketMs).toBe(60_000);
    expect(domain[0]).toBe(60_000);
    expect(buckets[0].counts.event).toBe(2);
    expect(buckets[0].counts.transaction).toBe(1);
    expect(buckets[0].total).toBe(3);
    expect(buckets[1].counts.span).toBe(1);
  });

  it('restricts to a window when given', () => {
    const records = [rec({ ts: 10_000 }), rec({ ts: 500_000 })];
    const { buckets } = bucketByTime(records, [0, 60_000]);
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(1);
  });

  it('ignores zero/garbage timestamps for the domain', () => {
    const records = [rec({ ts: 0 }), rec({ ts: 120_000 })];
    const { domain } = bucketByTime(records);
    expect(domain[0]).toBe(120_000);
  });

  it('utc alignment (the default) is the epoch grid', () => {
    const ts = Date.UTC(2026, 5, 10, 5, 17); // 05:17, mid-bucket
    const bucketMs = 3 * 3_600_000;
    const { domain } = bucketByTime([rec({ ts })], null, bucketMs, true);
    expect(domain[0]).toBe(Math.floor(ts / bucketMs) * bucketMs); // UTC 03:00
  });

  it('local alignment anchors the grid to local midnight (lines up with the calendar)', () => {
    // June, so no DST transition between these two local days in any zone
    const base = Date.parse('2026-06-10T00:00:00'); // local midnight (runner zone)
    const bucketMs = 3 * 3_600_000;
    const records = [rec({ ts: base + 3_600_000 }), rec({ ts: base + 30 * 3_600_000 })];
    const { domain } = bucketByTime(records, null, bucketMs, false);
    // the grid origin is itself a local midnight + whole buckets
    expect(zoneMidnight(domain[0], false)).toBe(domain[0]);
    // and the *next* local midnight falls exactly on a bucket boundary
    const nextMidnight = zoneMidnight(base + 24 * 3_600_000, false);
    expect((nextMidnight - domain[0]) % bucketMs).toBe(0);
  });

  it('handles empty input', () => {
    expect(bucketByTime([]).buckets).toHaveLength(0);
  });
});

describe('groupTransactions', () => {
  const records = [
    rec({ kind: 'transaction', name: 'GET /a', ts: 1000, duration: 10 }),
    rec({ kind: 'transaction', name: 'GET /a', ts: 2000, duration: 30 }),
    rec({ kind: 'transaction', name: 'GET /b', ts: 3000, duration: 5 }),
    rec({ kind: 'span', name: 'not-a-txn', ts: 1000, duration: 99 }),
  ];

  it('groups by name with count and summed duration', () => {
    const groups = groupTransactions(records);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.name === 'GET /a')!;
    expect(a.count).toBe(2);
    expect(a.totalDuration).toBe(40);
  });

  it('respects the time window', () => {
    const groups = groupTransactions(records, [1500, 3500]);
    expect(groups.find((g) => g.name === 'GET /a')?.count).toBe(1);
  });

  it('sorts by each key in both directions', () => {
    const groups = groupTransactions(records);
    expect(sortTxnGroups(groups, 'count', true)[0].name).toBe('GET /a');
    expect(sortTxnGroups(groups, 'totalDuration', false)[0].name).toBe('GET /b');
    expect(sortTxnGroups(groups, 'name', false)[0].name).toBe('GET /a');
  });
});

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe('transactionStats', () => {
  const records = [
    rec({ kind: 'transaction', name: 'GET /a', ts: 0, duration: 100, result: 'HTTP 2xx' }),
    rec({ kind: 'transaction', name: 'GET /a', ts: 60_000, duration: 300, result: 'HTTP 2xx' }),
    rec({ kind: 'transaction', name: 'GET /a', ts: 120_000, duration: 200, result: 'HTTP 5xx' }),
    rec({ kind: 'transaction', name: 'GET /b', ts: 0, duration: 999 }),
  ];

  it('computes count, percentiles, result mix, and rpm', () => {
    const s = transactionStats(records, 'GET /a');
    expect(s.count).toBe(3);
    expect(s.p50).toBe(200);
    expect(s.max).toBe(300);
    expect(s.resultCounts.get('HTTP 2xx')).toBe(2);
    expect(s.resultCounts.get('HTTP 5xx')).toBe(1);
    expect(s.rpm).toBeCloseTo(1.5, 5); // 3 requests over 2 minutes
  });

  it('respects the time window', () => {
    const s = transactionStats(records, 'GET /a', [50_000, 130_000]);
    expect(s.count).toBe(2);
  });
});

describe('logHistogram', () => {
  it('spreads heavy-tailed durations across log bins', () => {
    const durations = [1, 2, 10, 100, 1000, 1000];
    const buckets = logHistogram(durations, 10);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(6);
    const nonEmpty = buckets.filter((b) => b.count > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(4);
    expect(buckets[buckets.length - 1].count).toBe(2); // the two 1s outliers
  });

  it('clamps zero durations into the lowest bin and handles empty input', () => {
    expect(logHistogram([])).toHaveLength(0);
    const buckets = logHistogram([0, 0.001], 5);
    expect(buckets[0].count).toBe(2);
  });
});

describe('resolveBucketMs / bucketByTime override', () => {
  it('honors an explicit choice', () => {
    const records = [rec({ ts: 1000 }), rec({ ts: 3_600_000 })];
    expect(bucketByTime(records, null, 3_600_000).bucketMs).toBe(3_600_000);
  });

  it('escalates an absurd choice instead of drawing thousands of bars', () => {
    // 1-minute bars over 30 days would be 43,200 buckets
    const records = [rec({ ts: 1000 }), rec({ ts: 1000 + 30 * 86_400_000 })];
    const { bucketMs } = bucketByTime(records, null, 60_000);
    expect(bucketMs).toBeGreaterThan(60_000);
    expect((30 * 86_400_000) / bucketMs).toBeLessThanOrEqual(1500);
  });
});

describe('TxnGroup p95 / avg / errors', () => {
  const txn = (name: string, duration: number, result?: string) =>
    rec({ kind: 'transaction', name, ts: 1000, duration, result });

  it('computes avg, p95, and error counts per group', () => {
    const records = [
      txn('GET /a', 100, 'HTTP 2xx'),
      txn('GET /a', 200, 'HTTP 2xx'),
      txn('GET /a', 300, 'HTTP 5xx'),
      txn('GET /a', 400, 'error'),
    ];
    const [g] = groupTransactions(records);
    expect(g.avg).toBe(250);
    expect(g.p95).toBeCloseTo(385, 0); // linear interpolation over [100..400]
    expect(g.errors).toBe(2);
  });

  it('sorts by the new keys', () => {
    const records = [
      txn('a', 10, 'HTTP 5xx'),
      txn('b', 999, 'HTTP 2xx'),
    ];
    const groups = groupTransactions(records);
    expect(sortTxnGroups(groups, 'errors', true)[0].name).toBe('a');
    expect(sortTxnGroups(groups, 'p95', true)[0].name).toBe('b');
    expect(sortTxnGroups(groups, 'avg', false)[0].name).toBe('a');
  });
});

describe('blankPartialBuckets', () => {
  const H = 3_600_000;
  const mk = (t0: number, total: number): TimeBucket => ({ t0, counts: { event: total }, total });
  const make = (): BucketResult => ({
    buckets: [mk(0, 10), mk(H, 20), mk(2 * H, 30)],
    bucketMs: H,
    domain: [0, 3 * H],
  });

  it('returns the input unchanged when nothing is partial', () => {
    const r = make();
    expect(blankPartialBuckets(r, [])).toBe(r);
  });

  it('blanks buckets overlapping a partial span and keeps the rest', () => {
    const out = blankPartialBuckets(make(), [[H, 2 * H]]);
    expect(out.buckets.map((b) => b.total)).toEqual([10, 0, 30]);
    expect(out.buckets[1].counts).toEqual({});
  });

  it('blanks every hour bucket inside a partial day span', () => {
    const out = blankPartialBuckets(make(), [[0, 3 * H]]);
    expect(out.buckets.map((b) => b.total)).toEqual([0, 0, 0]);
  });

  it('does not blank a bucket that merely abuts the span edge (half-open)', () => {
    // span [0, H) ends exactly where the 2nd bucket starts → no overlap there
    const out = blankPartialBuckets(make(), [[0, H]]);
    expect(out.buckets.map((b) => b.total)).toEqual([0, 20, 30]);
  });
});
