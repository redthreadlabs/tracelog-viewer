import { describe, it, expect } from 'vitest';
import {
  pushMtime,
  cadence,
  isCurrent,
  nextExpected,
  BOOTSTRAP_STALE_MS,
} from './cadence';

const S = 1000;
const MIN = 60 * S;

describe('pushMtime', () => {
  it('appends strictly-newer observations', () => {
    let w: number[] = [];
    w = pushMtime(w, 100);
    w = pushMtime(w, 200);
    w = pushMtime(w, 300);
    expect(w).toEqual([100, 200, 300]);
  });

  it('ignores a value not strictly newer than the last (sub-second re-flush / clock step back)', () => {
    expect(pushMtime([100, 200], 200)).toEqual([100, 200]);
    expect(pushMtime([100, 200], 150)).toEqual([100, 200]);
    // unchanged input is returned as-is
    const w = [100, 200];
    expect(pushMtime(w, 200)).toBe(w);
  });

  it('caps the window to `max`, keeping the most recent', () => {
    let w: number[] = [];
    for (let i = 1; i <= 10; i++) w = pushMtime(w, i * 100, 4);
    expect(w).toEqual([700, 800, 900, 1000]);
  });
});

describe('cadence', () => {
  it('is null with fewer than two observations', () => {
    expect(cadence([])).toBeNull();
    expect(cadence([1000])).toBeNull();
  });

  it('is the median of consecutive deltas for a steady stream', () => {
    expect(cadence([0, 10 * S, 20 * S, 30 * S])).toBe(10 * S);
  });

  it('is robust to a single inflated gap (a missed poll)', () => {
    // deltas: 10s, 10s, 70s, 10s → median 10s, not the 25s mean
    const w = [0, 10 * S, 20 * S, 90 * S, 100 * S];
    expect(cadence(w)).toBe(10 * S);
  });
});

describe('isCurrent', () => {
  it('is false for a host never seen updating', () => {
    expect(isCurrent(1_000_000, [])).toBe(false);
  });

  it('bootstraps a single observation against the generous bootstrap window', () => {
    const now = 100 * MIN;
    // a 5-min-upload agent between flushes must stay current with no cadence yet
    expect(isCurrent(now, [now - 5 * MIN])).toBe(true);
    expect(isCurrent(now, [now - 15 * MIN])).toBe(false); // long dead
  });

  it('keeps a 5-min upload-cadence host current between flushes (the regression)', () => {
    const now = 100 * MIN;
    const m = [now - 14 * MIN, now - 9 * MIN, now - 4 * MIN]; // ~5-min cadence, flushed 4 min ago
    expect(isCurrent(now, m)).toBe(true); // threshold = max(3min, 3·5min) = 15 min
  });

  it('keeps a steadily-updating host current and drops one that stalls', () => {
    const now = 10_000_000;
    const steady = [now - 30 * S, now - 20 * S, now - 10 * S]; // ~10s cadence, just updated
    expect(isCurrent(now, steady)).toBe(true);
    // same cadence but silent for 4 min → past max(floor, k·10s) = 3 min
    const stalled = [now - 30 * S - 4 * MIN, now - 20 * S - 4 * MIN, now - 4 * MIN];
    expect(isCurrent(now, stalled)).toBe(false);
  });

  it('gives a slow-cadence host proportional headroom (k × cadence beats the floor)', () => {
    const now = 10_000_000;
    // 5-min cadence; silent 6 min. floor=3min, k·c=15min → still current
    const slow = [now - 16 * MIN, now - 11 * MIN, now - 6 * MIN];
    expect(isCurrent(now, slow)).toBe(true);
    // silent 20 min → past 15-min threshold → dropped
    const slowDead = [now - 30 * MIN, now - 25 * MIN, now - 20 * MIN];
    expect(isCurrent(now, slowDead)).toBe(false);
  });

  it('honors custom floor, k, and bootstrap window', () => {
    const now = 100 * MIN;
    const m = [now - 20 * S, now - 10 * S]; // cadence 10s, last 10s ago
    expect(isCurrent(now, m, { floorMs: 5 * S, k: 0.5 })).toBe(false); // max(5s, 5s) = 5s < 10s
    expect(isCurrent(now, m, { floorMs: 30 * S, k: 0.5 })).toBe(true); // floor 30s ≥ 10s
    // a single observation uses the bootstrap window, not the floor
    expect(isCurrent(now, [now - 500], { bootstrapMs: 400 })).toBe(false);
    expect(isCurrent(now, [now - 500], { bootstrapMs: 600 })).toBe(true);
  });

  it('treats a slightly-ahead server clock (now < last) as current', () => {
    const now = 1_000_000;
    expect(isCurrent(now, [now + 5 * S])).toBe(true);
  });
});

describe('nextExpected', () => {
  it('is null without a cadence, else last + cadence', () => {
    expect(nextExpected([5000])).toBeNull();
    expect(nextExpected([0, 10 * S, 20 * S])).toBe(30 * S);
  });
});

describe('BOOTSTRAP_STALE_MS', () => {
  it('exceeds the agent default 5-min S3 upload cadence with margin', () => {
    expect(BOOTSTRAP_STALE_MS).toBeGreaterThan(5 * MIN);
  });
});
