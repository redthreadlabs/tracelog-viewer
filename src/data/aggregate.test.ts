import { describe, it, expect } from 'vitest';
import {
  aggregateBySeries,
  chooseBucketMs,
  resolveBucketMs,
  groupTransactions,
  sortTxnGroups,
  percentile,
  transactionStats,
  logHistogram,
} from './aggregate';
import type { Rec } from './types';

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

describe('resolveBucketMs', () => {
  it('honors an explicit choice', () => {
    expect(resolveBucketMs(3_600_000, 3_600_000)).toBe(3_600_000);
  });

  it('escalates an absurd choice instead of drawing thousands of bars', () => {
    // 1-minute bars over 30 days would be 43,200 buckets
    const bucketMs = resolveBucketMs(30 * 86_400_000, 60_000);
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

describe('aggregateBySeries', () => {
  const sumDuration = {
    value: (r: Rec) => r.duration ?? 0,
    group: (r: Rec) => r.name,
    include: (r: Rec) => r.kind === 'transaction',
  };

  it('sums a field by group, keeping top-N and folding the tail into Other', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 1000, duration: 100 }),
      rec({ kind: 'transaction', name: 'A', ts: 2000, duration: 100 }), // A Σ=200
      rec({ kind: 'transaction', name: 'B', ts: 1500, duration: 50 }), // B Σ=50
      rec({ kind: 'transaction', name: 'C', ts: 1800, duration: 10 }), // C Σ=10 → Other
      rec({ kind: 'span', name: 'S', ts: 1000, duration: 999 }), // excluded by include
    ];
    const res = aggregateBySeries(records, null, 60_000, true, { ...sumDuration, topN: 2 });
    // series ranked by total desc, Other last
    expect(res.series).toEqual(['A', 'B', 'Other']);
    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0].values).toEqual({ A: 200, B: 50, Other: 10 });
    expect(res.buckets[0].total).toBe(260); // the span is not counted
  });

  it('buckets by time and the bar height is the sum across series', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 1000, duration: 10 }), // bucket 0
      rec({ kind: 'transaction', name: 'A', ts: 61_000, duration: 20 }), // bucket 1
      rec({ kind: 'transaction', name: 'B', ts: 62_000, duration: 5 }), // bucket 1
    ];
    const res = aggregateBySeries(records, null, 60_000, true, { ...sumDuration, topN: 8 });
    expect(res.series).toEqual(['A', 'B']); // only two groups, no Other
    expect(res.buckets.map((b) => b.values)).toEqual([{ A: 10 }, { A: 20, B: 5 }]);
    expect(res.buckets.map((b) => b.total)).toEqual([10, 25]);
  });

  it('counts (value = 1) rank by frequency', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 100 }),
      rec({ kind: 'transaction', name: 'A', ts: 200 }),
      rec({ kind: 'transaction', name: 'A', ts: 300 }), // A=3
      rec({ kind: 'transaction', name: 'B', ts: 400 }), // B=1
    ];
    const res = aggregateBySeries(records, null, 60_000, true, {
      group: (r) => r.name,
      value: () => 1,
      include: (r) => r.kind === 'transaction',
      topN: 8,
    });
    expect(res.series).toEqual(['A', 'B']);
    expect(res.buckets[0].values).toEqual({ A: 3, B: 1 });
  });

  it('drops the tail instead of folding into Other when noOther', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 1000, duration: 100 }), // A=100
      rec({ kind: 'transaction', name: 'B', ts: 1100, duration: 50 }), // B=50
      rec({ kind: 'transaction', name: 'C', ts: 1200, duration: 10 }), // C=10 → dropped
    ];
    const res = aggregateBySeries(records, null, 60_000, true, {
      ...sumDuration,
      topN: 2,
      noOther: true,
    });
    expect(res.series).toEqual(['A', 'B']); // no Other
    expect(res.buckets[0].values).toEqual({ A: 100, B: 50 });
    expect(res.buckets[0].total).toBe(150); // C is not counted at all
  });

  it('shows exactly the included set, each its own series', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 1000, duration: 100 }),
      rec({ kind: 'transaction', name: 'B', ts: 1100, duration: 50 }),
      rec({ kind: 'transaction', name: 'C', ts: 1200, duration: 10 }),
    ];
    const show = new Set(['A', 'C']);
    const res = aggregateBySeries(records, null, 60_000, true, {
      ...sumDuration,
      include: (r) => r.kind === 'transaction' && show.has(r.name),
      topN: show.size,
    });
    expect(res.series).toEqual(['A', 'C']); // B left out, no Other
    expect(res.buckets[0].values).toEqual({ A: 100, C: 10 });
  });

  it('respects the range and ignores excluded records', () => {
    const records = [
      rec({ kind: 'transaction', name: 'A', ts: 1000, duration: 100 }),
      rec({ kind: 'transaction', name: 'B', ts: 5000, duration: 999 }), // outside [0,2000]
    ];
    const res = aggregateBySeries(records, [0, 2000], 60_000, true, { ...sumDuration, topN: 8 });
    expect(res.series).toEqual(['A']);
    expect(res.buckets[0].values).toEqual({ A: 100 });
  });

  it('is empty when no record participates', () => {
    const res = aggregateBySeries(
      [rec({ kind: 'span', name: 'S', ts: 1000, duration: 5 })],
      null,
      60_000,
      true,
      { ...sumDuration, topN: 8 },
    );
    expect(res.buckets).toEqual([]);
    expect(res.series).toEqual([]);
  });
});
