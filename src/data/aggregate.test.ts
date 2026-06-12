import { describe, it, expect } from 'vitest';
import { bucketByTime, chooseBucketMs, groupTransactions, sortTxnGroups } from './aggregate';
import type { Rec } from './types';

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'event',
    ts: 0,
    channel: 'server',
    host: 'h',
    meta: {},
    name: 'x',
    raw: {},
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
