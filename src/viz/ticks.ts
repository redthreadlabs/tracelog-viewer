/**
 * Shared axis tick helpers (SPEC §7: every chart agrees on tick formatting).
 *
 * d3's scaleLog ignores the requested tick count and emits every 1–9×
 * multiple of each decade — unreadable for duration axes. logTicks emits
 * clean powers of 10, filling with 2× and 5× only when the domain spans few
 * decades, and thins to the requested maximum.
 */
import { isUtcMode } from '../ui/format';

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
 * Zone-aware time tick label: `14:05` normally, `14:05:30` when ticks land
 * on sub-minute boundaries, and the date at midnight. Replaces d3's default
 * multi-scale formatter (which mixes "08 PM" styles into the axis).
 */
export function timeTickFormat(domainMs: number): (d: Date | number) => string {
  const subMinute = domainMs < 3 * 60_000;
  return (d) => {
    const date = d instanceof Date ? d : new Date(+d);
    const h = isUtcMode() ? date.getUTCHours() : date.getHours();
    const m = isUtcMode() ? date.getUTCMinutes() : date.getMinutes();
    const s = isUtcMode() ? date.getUTCSeconds() : date.getSeconds();
    if (h === 0 && m === 0 && s === 0) {
      const month = (isUtcMode() ? date.getUTCMonth() : date.getMonth()) + 1;
      const day = isUtcMode() ? date.getUTCDate() : date.getDate();
      return `${pad2(month)}-${pad2(day)}`;
    }
    if (subMinute || s !== 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    return `${pad2(h)}:${pad2(m)}`;
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
