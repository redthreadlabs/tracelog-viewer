import { describe, it, expect } from 'vitest';
import {
  buildDurHist,
  durationBin,
  binValue,
  mergeBins,
  mergeRangeBins,
  quantileFromBins,
  DURHIST_BINS,
  type Bins,
} from './durhist';
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

describe('durationBin', () => {
  it('clamps below the floor and above the cap', () => {
    expect(durationBin(0)).toBe(0);
    expect(durationBin(0.001)).toBe(0); // < 10µs
    expect(durationBin(1e12)).toBe(DURHIST_BINS - 1); // overflow
  });

  it('is monotonic and log-spaced (a decade spans 5 bins)', () => {
    expect(durationBin(100)).toBe(durationBin(101)); // adjacent values, same bin
    expect(durationBin(1000) - durationBin(100)).toBe(5); // ×10 → +5 bins
  });
});

describe('buildDurHist', () => {
  it('bins transaction durations per hour/name; skips non-txn and missing duration', () => {
    const H = Date.UTC(2026, 5, 11, 0, 30);
    const idx = buildDurHist([
      rec({ kind: 'transaction', name: 'GET /a', ts: H, duration: 100 }),
      rec({ kind: 'transaction', name: 'GET /a', ts: H, duration: 105 }), // same bin as 100
      rec({ kind: 'transaction', name: 'GET /a', ts: H, duration: 1000 }), // a decade up → +5 bins
      rec({ kind: 'transaction', name: 'GET /a', ts: H }), // no duration → skipped
      rec({ kind: 'span', name: 'GET /a', ts: H, duration: 100 }), // not a txn → skipped
    ]);
    const bins = idx['2026-06-11T00']['GET /a'];
    expect(bins[durationBin(100)]).toBe(2);
    expect(bins[durationBin(1000)]).toBe(1);
  });
});

describe('quantileFromBins', () => {
  it('merges and estimates a quantile within the crossing bin', () => {
    const a: Bins = {};
    const b: Bins = {};
    for (let i = 0; i < 90; i++) a[durationBin(100)] = (a[durationBin(100)] ?? 0) + 1; // 90 @ ~100ms
    for (let i = 0; i < 10; i++) b[durationBin(5000)] = (b[durationBin(5000)] ?? 0) + 1; // 10 @ ~5s
    const merged: Bins = {};
    mergeBins(merged, a);
    mergeBins(merged, b);
    // p95 (95th of 100) lands in the 5s tail bin → between its edges
    const p95 = quantileFromBins(merged, 0.95)!;
    expect(p95).toBeGreaterThanOrEqual(binValue(durationBin(5000)));
    expect(p95).toBeLessThan(binValue(durationBin(5000) + 1));
    // p50 lands in the ~100ms bin
    const p50 = quantileFromBins(merged, 0.5)!;
    expect(p50).toBeGreaterThanOrEqual(binValue(durationBin(100)));
    expect(p50).toBeLessThan(binValue(durationBin(100) + 1));
  });

  it('is undefined when empty', () => {
    expect(quantileFromBins({}, 0.95)).toBeUndefined();
  });
});

describe('mergeRangeBins', () => {
  const H0 = Date.UTC(2026, 5, 11, 0); // 00:00
  const H1 = Date.UTC(2026, 5, 11, 1); // 01:00
  const H2 = Date.UTC(2026, 5, 11, 2); // 02:00
  const idx = {
    '2026-06-11T00': { 'GET /a': { [durationBin(100)]: 3 } },
    '2026-06-11T01': { 'GET /a': { [durationBin(100)]: 2 }, 'GET /b': { [durationBin(50)]: 4 } },
    '2026-06-11T02': { 'GET /a': { [durationBin(100)]: 9 } },
  };

  it('merges only hours fully inside [from, to), summing per name', () => {
    const into = new Map<string, Bins>();
    // [00:00, 02:00) → includes the 00 and 01 hours, excludes 02 (its end spills past `to`)
    mergeRangeBins(idx, H0, H2, into);
    expect(into.get('GET /a')![durationBin(100)]).toBe(5); // 3 + 2, not the 9 at 02:00
    expect(into.get('GET /b')![durationBin(50)]).toBe(4);
  });

  it('excludes an hour whose end spills past `to`', () => {
    const into = new Map<string, Bins>();
    mergeRangeBins(idx, H0, H1 + 1, into); // only the 00 hour fits whole
    expect(into.get('GET /a')![durationBin(100)]).toBe(3);
  });
});
