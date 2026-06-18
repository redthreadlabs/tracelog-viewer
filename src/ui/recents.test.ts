import { describe, it, expect } from 'vitest';
import { mergeRecent, recentKey, type RecentRange } from './recents';

const last = (amount: number, unit: 'hours' | 'days'): RecentRange => ({
  kind: 'spec',
  spec: { kind: 'last', amount, unit },
});
const abs = (from: number, to: number): RecentRange => ({ kind: 'absolute', from, to });

describe('recentKey', () => {
  it('keys specs by token and absolutes by window', () => {
    expect(recentKey(last(1.5, 'hours'))).toBe('s:last-1.5-hours');
    expect(recentKey(abs(100, 200))).toBe('a:100-200');
  });
});

describe('mergeRecent', () => {
  it('prepends newest first', () => {
    const a = last(1, 'hours');
    const b = last(2, 'days');
    expect(mergeRecent([a], b)).toEqual([b, a]);
  });

  it('dedups: re-applying a range moves it to the front, no duplicate', () => {
    const a = last(1, 'hours');
    const b = last(2, 'days');
    const merged = mergeRecent([b, a], a);
    expect(merged).toEqual([a, b]);
    expect(merged).toHaveLength(2);
  });

  it('dedups absolute windows by from/to', () => {
    const x = abs(100, 200);
    expect(mergeRecent([abs(100, 200)], x)).toEqual([x]);
  });

  it('caps the list, keeping the most recent', () => {
    let list: RecentRange[] = [];
    for (let i = 1; i <= 10; i++) list = mergeRecent(list, last(i, 'hours'), 8);
    expect(list).toHaveLength(8);
    expect(list[0]).toEqual(last(10, 'hours'));
    expect(list.some((r) => recentKey(r) === 's:last-1-hours')).toBe(false); // oldest dropped
    expect(list.some((r) => recentKey(r) === 's:last-2-hours')).toBe(false);
  });
});
