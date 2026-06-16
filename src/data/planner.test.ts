import { describe, it, expect } from 'vitest';
import { planIndexBatch, sourceOf, type MetricSpec } from './planner';
import type { TxnFileIndex } from './txnindex';
import { durationBin, type DurHistFileIndex } from './durhist';

const H0 = '2026-06-11T00';
const H1 = '2026-06-11T01';
const from = Date.UTC(2026, 5, 11, 0);
const to = Date.UTC(2026, 5, 11, 2);

// two files (e.g. two hosts), same hours, so totals must sum across both
const cubeA: TxnFileIndex = {
  [H0]: { 'GET /a': { c: 10, d: 1000, e: 1 }, 'GET /b': { c: 4, d: 200, e: 0 } },
  [H1]: { 'GET /a': { c: 6, d: 600, e: 0 } },
};
const cubeB: TxnFileIndex = {
  [H0]: { 'GET /a': { c: 5, d: 500, e: 2 } },
};

describe('sourceOf', () => {
  it('routes metrics to the cube or the histogram', () => {
    expect(sourceOf({ key: 'c', op: 'count', shape: 'total' })).toBe('cube');
    expect(sourceOf({ key: 'd', op: 'sum', field: 'duration', shape: 'series' })).toBe('cube');
    expect(sourceOf({ key: 'e', op: 'sum', field: 'errors', shape: 'total' })).toBe('cube');
    expect(sourceOf({ key: 'p', op: 'p95', field: 'duration', shape: 'total' })).toBe('histogram');
    expect(sourceOf({ key: 'x', op: 'avg', field: 'duration', shape: 'total' })).toBeNull();
  });
});

describe('planIndexBatch', () => {
  it('produces series AND totals from one cube pass, summed across files', () => {
    const metrics: MetricSpec[] = [
      { key: 'series', op: 'sum', field: 'duration', shape: 'series' },
      { key: 'count', op: 'count', shape: 'total' },
      { key: 'sumDur', op: 'sum', field: 'duration', shape: 'total' },
      { key: 'errors', op: 'sum', field: 'errors', shape: 'total' },
    ];
    const { series, totals } = planIndexBatch(
      { metrics, range: [from, to], bucketMs: null, utc: true, topN: 8 },
      [cubeA, cubeB],
      [],
    );

    // totals sum both files + both hours
    expect(totals.get('count')!.get('GET /a')).toBe(10 + 6 + 5); // 21
    expect(totals.get('count')!.get('GET /b')).toBe(4);
    expect(totals.get('sumDur')!.get('GET /a')).toBe(1000 + 600 + 500); // 2100
    expect(totals.get('errors')!.get('GET /a')).toBe(1 + 2); // 3
    expect(totals.get('errors')!.get('GET /b')).toBeUndefined(); // its e=0, skipped

    // the series totals (sum across its buckets) match the cube totals — same pass
    const s = series.get('series')!;
    const seriesTotalA = s.buckets.reduce((acc, b) => acc + (b.values['GET /a'] ?? 0), 0);
    expect(seriesTotalA).toBe(2100);
  });

  it('skips zero contributions and respects the series selection (show)', () => {
    const metrics: MetricSpec[] = [
      { key: 'series', op: 'sum', field: 'duration', shape: 'series' },
    ];
    const { series } = planIndexBatch(
      { metrics, range: [from, to], bucketMs: null, utc: true, show: new Set(['GET /a']), topN: 1 },
      [cubeA, cubeB],
      [],
    );
    const s = series.get('series')!;
    // only the selected transaction is in the series
    expect(s.series).toEqual(['GET /a']);
  });

  it('reads P95 from the merged histogram bins (total shape)', () => {
    const bin100 = durationBin(100);
    const bin5000 = durationBin(5000);
    // 90 @ ~100ms across two files, 10 @ ~5s — p95 lands in the 5s bin
    const histA: DurHistFileIndex = { [H0]: { 'GET /a': { [bin100]: 60, [bin5000]: 10 } } };
    const histB: DurHistFileIndex = { [H0]: { 'GET /a': { [bin100]: 30 } } };
    const metrics: MetricSpec[] = [{ key: 'p95', op: 'p95', field: 'duration', shape: 'total' }];
    const { totals } = planIndexBatch(
      { metrics, range: [from, to], bucketMs: null, utc: true, topN: 8 },
      [],
      [histA, histB],
    );
    const p95 = totals.get('p95')!.get('GET /a')!;
    expect(p95).toBeGreaterThanOrEqual(5000);
    expect(p95).toBeLessThan(10_000);
  });
});
