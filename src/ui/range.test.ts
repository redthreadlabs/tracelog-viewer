import { describe, it, expect } from 'vitest';
import {
  resolveRange,
  rangeToken,
  parseRangeToken,
  rangeLabel,
  type RangeSpec,
} from './range';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// 2026-06-17 15:30 UTC (a Wednesday)
const NOW = Date.UTC(2026, 5, 17, 15, 30, 0);

describe('resolveRange — last (rolling, zone-independent)', () => {
  it('is [now − span, now] regardless of zone', () => {
    const spec: RangeSpec = { kind: 'last', amount: 1.5, unit: 'hours' };
    expect(resolveRange(spec, NOW, true)).toEqual([NOW - 1.5 * HOUR, NOW]);
    expect(resolveRange(spec, NOW, false)).toEqual([NOW - 1.5 * HOUR, NOW]);
  });
});

describe('resolveRange — named (UTC)', () => {
  it('today is [UTC midnight, now]', () => {
    expect(resolveRange({ kind: 'named', name: 'today' }, NOW, true)).toEqual([
      Date.UTC(2026, 5, 17),
      NOW,
    ]);
  });
  it('yesterday is the full prior UTC day', () => {
    expect(resolveRange({ kind: 'named', name: 'yesterday' }, NOW, true)).toEqual([
      Date.UTC(2026, 5, 16),
      Date.UTC(2026, 5, 17) - 1,
    ]);
  });
  it('this-month / last-month snap to the calendar month', () => {
    expect(resolveRange({ kind: 'named', name: 'this-month' }, NOW, true)).toEqual([
      Date.UTC(2026, 5, 1),
      NOW,
    ]);
    expect(resolveRange({ kind: 'named', name: 'last-month' }, NOW, true)).toEqual([
      Date.UTC(2026, 4, 1),
      Date.UTC(2026, 5, 1) - 1,
    ]);
  });
  it('this-week starts on a UTC Monday midnight, ≤ now, within 7 days', () => {
    const [start, end] = resolveRange({ kind: 'named', name: 'this-week' }, NOW, true);
    expect(end).toBe(NOW);
    expect(start % DAY).toBe(0); // a UTC midnight
    expect(new Date(start).getUTCDay()).toBe(1); // Monday
    expect(NOW - start).toBeLessThan(7 * DAY);
    expect(start).toBeLessThanOrEqual(NOW);
  });
});

describe('resolveRange — named (local)', () => {
  it('today snaps to local midnight (zone-independent assertion)', () => {
    const [start, end] = resolveRange({ kind: 'named', name: 'today' }, NOW, false);
    expect(end).toBe(NOW);
    const d = new Date(start);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect(start).toBeLessThanOrEqual(NOW);
  });
});

describe('rangeToken / parseRangeToken', () => {
  it('round-trips last + named', () => {
    expect(rangeToken({ kind: 'last', amount: 1.5, unit: 'hours' })).toBe('last-1.5-hours');
    expect(rangeToken({ kind: 'named', name: 'this-week' })).toBe('this-week');
    expect(parseRangeToken('last-1.5-hours')).toEqual({ kind: 'last', amount: 1.5, unit: 'hours' });
    expect(parseRangeToken('this-week')).toEqual({ kind: 'named', name: 'this-week' });
  });
  it('rejects garbage and non-positive amounts', () => {
    expect(parseRangeToken('')).toBeNull();
    expect(parseRangeToken('nonsense')).toBeNull();
    expect(parseRangeToken('last-0-hours')).toBeNull();
    expect(parseRangeToken('last-abc-hours')).toBeNull();
    expect(parseRangeToken('last-3-fortnights')).toBeNull();
  });
});

describe('rangeLabel', () => {
  it('singularizes a unit of 1', () => {
    expect(rangeLabel({ kind: 'last', amount: 1, unit: 'hours' })).toBe('Last 1 hour');
    expect(rangeLabel({ kind: 'last', amount: 2, unit: 'hours' })).toBe('Last 2 hours');
    expect(rangeLabel({ kind: 'last', amount: 1.5, unit: 'days' })).toBe('Last 1.5 days');
    expect(rangeLabel({ kind: 'named', name: 'this-week' })).toBe('This week');
  });
});
