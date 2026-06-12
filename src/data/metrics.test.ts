import { describe, it, expect } from 'vitest';
import { runtimeSeries, deploymentMarkers, breakdownSelfTime } from './metrics';
import type { Rec } from './types';

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'metricset',
    ts: 0,
    channel: 'server',
    host: 'h1',
    sourceKey: 'k',
    meta: {},
    name: '',
    rawLine: '',
    ...partial,
  };
}

describe('runtimeSeries', () => {
  it('extracts a per-host time-ordered series for one sample', () => {
    const records = [
      rec({ ts: 2000, samples: { 'nodejs.memory.heap.used.bytes': 20 } }),
      rec({ ts: 1000, samples: { 'nodejs.memory.heap.used.bytes': 10 } }),
      rec({ ts: 1500, host: 'h2', samples: { 'nodejs.memory.heap.used.bytes': 99 } }),
      rec({ ts: 3000, samples: { 'other.metric': 5 } }),
      rec({ ts: 4000, kind: 'event' }),
    ];
    const series = runtimeSeries(records, 'nodejs.memory.heap.used.bytes');
    expect(series.get('h1')).toEqual([
      { t: 1000, v: 10 },
      { t: 2000, v: 20 },
    ]);
    expect(series.get('h2')).toHaveLength(1);
  });

  it('respects the window', () => {
    const records = [
      rec({ ts: 1000, samples: { m: 1 } }),
      rec({ ts: 9000, samples: { m: 2 } }),
    ];
    expect(runtimeSeries(records, 'm', [0, 5000]).get('h1')).toHaveLength(1);
  });
});

describe('deploymentMarkers', () => {
  it('marks the first appearance of each version after the baseline', () => {
    const records = [
      rec({ ts: 1000, meta: { serviceVersion: '1.0.0' } }),
      rec({ ts: 2000, meta: { serviceVersion: '1.0.0' } }),
      rec({ ts: 3000, meta: { serviceVersion: '1.1.0' } }),
      rec({ ts: 3500, meta: { serviceVersion: '1.1.0' } }),
      rec({ ts: 5000, meta: { serviceVersion: '1.2.0' } }),
    ];
    expect(deploymentMarkers(records)).toEqual([
      { t: 3000, version: '1.1.0' },
      { t: 5000, version: '1.2.0' },
    ]);
  });

  it('returns nothing for a single version', () => {
    expect(deploymentMarkers([rec({ ts: 1, meta: { serviceVersion: '1.0.0' } })])).toEqual([]);
  });
});

describe('breakdownSelfTime', () => {
  it('buckets self-time by span type/subtype, µs→ms, types by total desc', () => {
    const mk = (ts: number, type: string, subtype: string | undefined, us: number) =>
      rec({
        ts,
        result: subtype ? `${type}/${subtype}` : type,
        samples: { 'span.self_time.sum.us': us },
      });
    const result = breakdownSelfTime([
      mk(60_000, 'db', 'mongodb', 5000),
      mk(61_000, 'db', 'mongodb', 3000),
      mk(60_500, 'app', undefined, 50_000),
    ]);
    expect(result.types).toEqual(['app', 'db/mongodb']);
    expect(result.buckets[0].byType.get('db/mongodb')).toBe(8);
    expect(result.buckets[0].byType.get('app')).toBe(50);
  });

  it('ignores runtime metricsets without span attribution', () => {
    const result = breakdownSelfTime([
      rec({ ts: 1000, samples: { 'span.self_time.sum.us': 100 } }), // no result attribution
    ]);
    expect(result.buckets).toHaveLength(0);
  });
});
