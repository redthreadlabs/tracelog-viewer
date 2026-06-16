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

/**
 * Measure rendered text width via a shared canvas 2D context — used to size an
 * axis gutter to its actual labels. `font` is a CSS font shorthand, e.g.
 * `10.5px ui-monospace, monospace`. Falls back to a rough monospace estimate
 * when canvas is unavailable (a non-DOM test).
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
export function measureTextWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/**
 * The left margin a vertical (value) axis needs so its tick labels never clip:
 * the widest already-formatted label plus d3's tick mark + label padding and a
 * small gutter. Pass the formatted tick strings and the axis font; callers
 * combine it with a baseline minimum (Math.max) so short labels keep a stable
 * axis width while wide ones (e.g. "16.7 min") always fit, at any chart width.
 */
export function axisLeftMargin(
  labels: string[],
  font: string,
  { tickSize = 6, pad = 3, gutter = 4 }: { tickSize?: number; pad?: number; gutter?: number } = {},
): number {
  let widest = 0;
  for (const s of labels) widest = Math.max(widest, measureTextWidth(s, font));
  return Math.ceil(widest) + tickSize + pad + gutter;
}
