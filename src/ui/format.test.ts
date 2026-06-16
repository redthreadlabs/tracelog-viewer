import { describe, it, expect } from 'vitest';
import {
  fmtCount,
  fmtHumane,
  setUtcMode,
  fmtBytesRough,
  fmtScaleTime,
  durationAxisFormat,
  bytesAxisFormat,
  omitZero,
} from './format';

describe('durationAxisFormat — one unit, minimal precision, no zero label', () => {
  it('drops noise decimals and shares the unit (the overview case)', () => {
    // d3 picks nice MILLISECOND ticks (1e6 steps); shown in minutes they were
    // 16.7 / 33.3 / … and the zero line was "0 µs"
    const ticks = [0, 1e6, 2e6, 3e6, 4e6, 5e6]; // 0 .. 83.3 min
    const f = durationAxisFormat(ticks);
    expect(f(0)).toBe(''); // zero origin omitted
    expect(f(1e6)).toBe('17 min'); // 16.67 → 17, no decimal noise
    expect(f(3e6)).toBe('50 min');
    expect(f(5e6)).toBe('83 min');
    expect(ticks.slice(1).every((t) => f(t).endsWith(' min'))).toBe(true);
  });

  it('keeps decimals that actually carry precision', () => {
    const ticks = [0, 250, 500, 750, 1000]; // ms, max 1s → unit "s", step 0.25
    const f = durationAxisFormat(ticks);
    expect(f(0)).toBe('');
    expect(f(250)).toBe('0.25 s'); // not rounded to 0.3
    expect(f(1000)).toBe('1.00 s');
  });

  it('does not print a pointless .0 for integer steps', () => {
    const ticks = [0, 5 * 60_000, 10 * 60_000, 15 * 60_000]; // 0,5,10,15 min
    const f = durationAxisFormat(ticks);
    expect(f(5 * 60_000)).toBe('5 min');
    expect(f(15 * 60_000)).toBe('15 min');
  });
});

describe('bytesAxisFormat / omitZero', () => {
  it('shares one byte unit and omits zero', () => {
    const MB = 1024 * 1024;
    const f = bytesAxisFormat([0, 50 * MB, 100 * MB, 150 * MB]);
    expect(f(0)).toBe('');
    expect(f(50 * MB)).toBe('50 MB');
    expect(f(150 * MB)).toBe('150 MB');
  });

  it('omitZero blanks the origin and passes other values through', () => {
    const f = omitZero(fmtCount);
    expect(f(0)).toBe('');
    expect(f(1200)).toBe('1,200');
  });
});

describe('fmtScaleTime', () => {
  it('renders no finer than the bar width', () => {
    setUtcMode(true);
    try {
      const t = Date.UTC(2020, 5, 10, 14, 5, 30, 118); // June 10 2020, 14:05:30.118 UTC
      expect(fmtScaleTime(t, 86_400_000)).toBe('June 10, 2020'); //   daily → date only
      expect(fmtScaleTime(t, 3_600_000)).toBe('June 10, 2020, 2pm'); // hourly → the hour
      expect(fmtScaleTime(t, 60_000)).toBe('June 10, 2020, 2:05pm'); // minute
      expect(fmtScaleTime(t, 1000)).toBe('June 10, 2020, 2:05:30pm'); // sub-minute → second
    } finally {
      setUtcMode(false);
    }
  });
});

describe('fmtBytesRough', () => {
  it('shows one decimal below 10, whole numbers at 10+', () => {
    expect(fmtBytesRough(4 * 1024 ** 3)).toBe('4.0 GB');
    expect(fmtBytesRough(4.6 * 1024 ** 3)).toBe('4.6 GB');
    expect(fmtBytesRough(12 * 1024 ** 3)).toBe('12 GB');
    expect(fmtBytesRough(7 * 1024 ** 2)).toBe('7.0 MB');
    expect(fmtBytesRough(412 * 1024)).toBe('412 KB');
    expect(fmtBytesRough(512)).toBe('512 B');
  });
});

describe('fmtCount', () => {
  it('groups with commas', () => {
    expect(fmtCount(12345)).toBe('12,345');
    expect(fmtCount(1234567)).toBe('1,234,567');
    expect(fmtCount(999)).toBe('999');
  });
});

describe('fmtHumane', () => {
  // a fixed "now": 2026-06-12T20:00:00 UTC
  const NOW = Date.UTC(2026, 5, 12, 20, 0, 0);

  it('relative under an hour', () => {
    expect(fmtHumane(NOW - 30_000, NOW)).toBe('30 seconds ago');
    expect(fmtHumane(NOW - 1000, NOW)).toBe('1 second ago');
    expect(fmtHumane(NOW - 12 * 60_000, NOW)).toBe('12 minutes ago');
  });

  it('clock time for earlier today, yesterday, month-day, and year (UTC mode)', () => {
    setUtcMode(true);
    try {
      expect(fmtHumane(Date.UTC(2026, 5, 12, 16, 30), NOW)).toBe('4:30pm');
      expect(fmtHumane(Date.UTC(2026, 5, 12, 9, 5), NOW)).toBe('9:05am');
      expect(fmtHumane(Date.UTC(2026, 5, 11, 23, 0), NOW)).toBe('yesterday');
      expect(fmtHumane(Date.UTC(2026, 5, 3, 12, 0), NOW)).toBe('June 3');
      expect(fmtHumane(Date.UTC(2025, 11, 25, 12, 0), NOW)).toBe('December 25, 2025');
    } finally {
      setUtcMode(false);
    }
  });
});
