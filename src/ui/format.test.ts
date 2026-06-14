import { describe, it, expect } from 'vitest';
import { fmtCount, fmtHumane, setUtcMode, fmtBytesRough, fmtScaleTime } from './format';

describe('fmtScaleTime', () => {
  it('renders no finer than the bar width', () => {
    setUtcMode(true);
    try {
      const t = Date.UTC(2020, 5, 10, 14, 5, 30, 118); // June 10 2020, 14:05:30.118 UTC
      expect(fmtScaleTime(t, 86_400_000)).toBe('June 10, 2020'); //   daily → date only
      expect(fmtScaleTime(t, 3_600_000)).toBe('June 10, 2020, 2p'); // hourly → the hour
      expect(fmtScaleTime(t, 60_000)).toBe('June 10, 2020, 2:05p'); // minute
      expect(fmtScaleTime(t, 1000)).toBe('June 10, 2020, 2:05:30p'); // sub-minute → second
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
      expect(fmtHumane(Date.UTC(2026, 5, 12, 16, 30), NOW)).toBe('4:30p');
      expect(fmtHumane(Date.UTC(2026, 5, 12, 9, 5), NOW)).toBe('9:05a');
      expect(fmtHumane(Date.UTC(2026, 5, 11, 23, 0), NOW)).toBe('yesterday');
      expect(fmtHumane(Date.UTC(2026, 5, 3, 12, 0), NOW)).toBe('June 3');
      expect(fmtHumane(Date.UTC(2025, 11, 25, 12, 0), NOW)).toBe('December 25, 2025');
    } finally {
      setUtcMode(false);
    }
  });
});
