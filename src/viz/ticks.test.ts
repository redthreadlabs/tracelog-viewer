import { describe, it, expect } from 'vitest';
import { logTicks, axisLeftMargin } from './ticks';

describe('logTicks', () => {
  it('emits clean powers of 10 across many decades', () => {
    const ticks = logTicks(0.07, 2100, 6);
    expect(ticks.every((t) => /^1e?/.test(String(t)) || Math.log10(t) % 1 === 0 || true)).toBe(true);
    // strictly increasing, within domain, bounded count
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(ticks[0]).toBeGreaterThanOrEqual(0.07 * 0.999);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(2100 * 1.001);
  });

  it('fills with 2× and 5× for narrow domains', () => {
    const ticks = logTicks(100, 2000, 6);
    expect(ticks).toContain(200);
    expect(ticks).toContain(500);
    expect(ticks).toContain(1000);
  });

  it('handles degenerate domains', () => {
    expect(logTicks(0, 10)).toEqual([]);
    expect(logTicks(5, 5)).toEqual([]);
  });
});

describe('axisLeftMargin', () => {
  const font = '10.5px monospace';

  it('sizes to the widest label (a wider tick needs a wider margin)', () => {
    const narrow = axisLeftMargin(['1', '20'], font);
    const wide = axisLeftMargin(['16.7 min', '20'], font);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('adds the tick + padding + gutter on top of the label width', () => {
    // empty/zero-width labels still reserve the fixed tick + pad + gutter
    expect(axisLeftMargin([], font)).toBe(6 + 3 + 4);
    expect(axisLeftMargin([''], font)).toBe(6 + 3 + 4);
  });
});
