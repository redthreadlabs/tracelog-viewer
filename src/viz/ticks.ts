/**
 * Shared axis tick helpers (SPEC §7: every chart agrees on tick formatting).
 * Log-axis ticks live here; time-axis gridlines + labels live in timegrid.ts.
 *
 * d3's scaleLog ignores the requested tick count and emits every 1–9×
 * multiple of each decade — unreadable for duration axes. logTicks emits
 * clean powers of 10, filling with 2× and 5× only when the domain spans few
 * decades, and thins to the requested maximum.
 */
export function logTicks(min: number, max: number, maxTicks = 6): number[] {
  if (!(min > 0) || !(max > min)) return [];
  const loExp = Math.ceil(Math.log10(min) - 1e-9);
  const hiExp = Math.floor(Math.log10(max) + 1e-9);
  const decades = hiExp - loExp + 1;

  let candidates: number[] = [];
  const mantissas = decades <= 2 ? [1, 2, 5] : decades <= 4 ? [1, 3] : [1];
  for (let e = loExp - 1; e <= hiExp + 1; e++) {
    for (const m of mantissas) {
      candidates.push(m * Math.pow(10, e));
    }
  }
  candidates = candidates.filter((v) => v >= min * 0.999 && v <= max * 1.001);

  while (candidates.length > maxTicks) {
    candidates = candidates.filter((_, i) => i % 2 === 0);
  }
  return candidates;
}

/**
 * Content-box width of a chart host. clientWidth includes padding, and
 * .chart-host has some — an SVG sized to clientWidth overflows its panel
 * by the horizontal padding (visibly misaligning right edges).
 */
export function contentWidth(container: HTMLElement, min: number): number {
  const cs = getComputedStyle(container);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(container.clientWidth - pad, min);
}
