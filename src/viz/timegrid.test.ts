import { describe, it, expect } from 'vitest';
import { levelOf, formatTick } from './timegrid';

// All assertions use UTC (utc=true) so they don't depend on the test runner's
// local zone.
const utc = true;
const ms = (iso: string) => Date.parse(iso);

describe('levelOf — significance of a boundary', () => {
  it('grades the calendar hierarchy', () => {
    expect(levelOf(ms('2026-01-01T00:00:00Z'), utc)).toBe('year');
    expect(levelOf(ms('2026-06-01T00:00:00Z'), utc)).toBe('month');
    expect(levelOf(ms('2026-06-08T00:00:00Z'), utc)).toBe('week'); // a Monday
    expect(levelOf(ms('2026-06-10T00:00:00Z'), utc)).toBe('day'); // a Wednesday
    expect(levelOf(ms('2026-06-10T14:00:00Z'), utc)).toBe('hour');
    expect(levelOf(ms('2026-06-10T14:30:00Z'), utc)).toBe('minute');
    expect(levelOf(ms('2026-06-10T14:30:15Z'), utc)).toBe('second');
  });

  it('prefers the coarsest matching boundary', () => {
    // Jan 1 is also a month-start and (some years) a Monday, but year wins
    expect(levelOf(ms('2024-01-01T00:00:00Z'), utc)).toBe('year');
    // the 1st of a month that is also a Monday still reads as month
    expect(levelOf(ms('2025-09-01T00:00:00Z'), utc)).toBe('month'); // Mon Sep 1 2025
  });
});

describe('formatTick — humane labels per level', () => {
  it('labels each level in its own unit', () => {
    expect(formatTick(ms('2026-01-01T00:00:00Z'), 'year', utc, '').text).toBe('2026');
    expect(formatTick(ms('2026-06-01T00:00:00Z'), 'month', utc, '').text).toBe('Jun');
    expect(formatTick(ms('2026-06-10T14:00:00Z'), 'hour', utc, '').text).toBe('14:00');
    expect(formatTick(ms('2026-06-10T14:05:00Z'), 'minute', utc, '').text).toBe('14:05');
    expect(formatTick(ms('2026-06-10T14:05:30Z'), 'second', utc, '').text).toBe('14:05:30');
  });

  it('drops a repeated month from consecutive day labels', () => {
    const first = formatTick(ms('2026-06-09T00:00:00Z'), 'day', utc, '');
    expect(first.text).toBe('Jun 9');
    // next day, same month → bare day number
    const second = formatTick(ms('2026-06-10T00:00:00Z'), 'day', utc, first.monthKey);
    expect(second.text).toBe('10');
    // crossing into a new month brings the name back
    const third = formatTick(ms('2026-07-01T00:00:00Z'), 'day', utc, second.monthKey);
    expect(third.text).toBe('Jul 1');
  });
});
