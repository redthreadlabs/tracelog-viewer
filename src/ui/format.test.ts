import { describe, it, expect } from 'vitest';
import { fmtCount, fmtHumane, setUtcMode } from './format';

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
