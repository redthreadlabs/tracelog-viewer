/**
 * Shared time-axis grid for every time-series chart (timebars, stackbars,
 * line, scatter). Instead of fixed per-calendar-unit weights, it reads the
 * current viewport and derives a *relative* hierarchy of gridlines:
 *
 *   - minor  — faint, the finest grid (≥ ~4 bars wide, so a chart isn't
 *              gridded until a few bars have passed)
 *   - medium — heavier (only when a nice interval sits between minor & major)
 *   - major  — heaviest, the coarse date anchor (a calendar boundary that
 *              actually appears in view)
 *
 * Weight is by tier *rank*, not by calendar unit — so a year boundary under
 * an hourly grid is just "the major line of the day," never over-escalated.
 *
 * Labels are split by unit class, not by tier: the running fine times go on
 * the BOTTOM axis (`06:00`); the coarse date anchor goes along the TOP, to
 * the right of its line, in a grey matched to the line's prominence. The top
 * row therefore never mixes a `Jun 9` with an `06:00`.
 */
import type { Selection } from 'd3-selection';
import { isUtcMode } from '../ui/format';

export type TimeLevel = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface Step {
  ms: number; // approximate span — only used to choose density
  level: TimeLevel;
  mult: number;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

/** Ascending ladder of human-meaningful steps. */
const STEPS: Step[] = [
  { ms: SEC, level: 'second', mult: 1 },
  { ms: 5 * SEC, level: 'second', mult: 5 },
  { ms: 15 * SEC, level: 'second', mult: 15 },
  { ms: 30 * SEC, level: 'second', mult: 30 },
  { ms: MIN, level: 'minute', mult: 1 },
  { ms: 5 * MIN, level: 'minute', mult: 5 },
  { ms: 15 * MIN, level: 'minute', mult: 15 },
  { ms: 30 * MIN, level: 'minute', mult: 30 },
  { ms: HR, level: 'hour', mult: 1 },
  { ms: 3 * HR, level: 'hour', mult: 3 },
  { ms: 6 * HR, level: 'hour', mult: 6 },
  { ms: 12 * HR, level: 'hour', mult: 12 },
  { ms: DAY, level: 'day', mult: 1 },
  { ms: 7 * DAY, level: 'week', mult: 1 },
  { ms: 30 * DAY, level: 'month', mult: 1 },
  { ms: 365 * DAY, level: 'year', mult: 1 },
];

/** Opacity of `--ink` per tier rank — relative, not per calendar unit. */
const TIER_OPACITY = { minor: 0.07, medium: 0.14, major: 0.22 };

const MIN_BARS = 4; // minor gridline spans at least this many bars
const MIN_MINOR_PX = 26; // ...and never finer than this on screen
const MAJOR_MIN_PX = 150; // the coarse anchor lines, comfortably spaced
const BOTTOM_LABEL_PX = 52; // bottom time labels no closer than this

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isTime = (lvl: TimeLevel): boolean => lvl === 'second' || lvl === 'minute' || lvl === 'hour';

export interface Tiers {
  minor: Step;
  medium: Step | null;
  major: Step | null;
}

/**
 * Pick the minor / medium / major intervals for a viewport. Pure and
 * unit-testable. `major` prefers a *date* boundary (day/week/month/year) that
 * actually appears, so the top row is always a date; if none is in view (a
 * pure sub-day window) it falls back to the coarsest sub-day step that fits.
 */
export function chooseTiers(
  domain: [number, number],
  innerW: number,
  bucketMs: number | undefined,
  utc: boolean,
): Tiers {
  const span = domain[1] - domain[0];
  const px = (ms: number): number => (innerW * ms) / span;

  // minor: ≥ ~4 bars, and not denser than MIN_MINOR_PX on screen
  const minMinorMs = Math.max(bucketMs ? MIN_BARS * bucketMs : 0, (span * MIN_MINOR_PX) / innerW);
  const minorRaw = STEPS.findIndex((s) => s.ms >= minMinorMs);
  const minorI = minorRaw < 0 ? STEPS.length - 1 : minorRaw;

  // major: the coarse anchor — prefer the finest date step that's spaced
  // comfortably and has at least one boundary in view
  const DAY_I = STEPS.findIndex((s) => s.level === 'day');
  let majorI = STEPS.findIndex(
    (s, i) => i >= DAY_I && i > minorI && px(s.ms) >= MAJOR_MIN_PX,
  );
  if (majorI >= 0 && ticksFor(domain[0], domain[1], STEPS[majorI], utc).length === 0) majorI = -1;
  if (majorI < 0) {
    majorI = STEPS.findIndex((s, i) => i > minorI && px(s.ms) >= MAJOR_MIN_PX);
  }

  // medium: a rung between minor and major, only when there's room for one
  let mediumI = -1;
  if (majorI > minorI + 1) {
    mediumI = Math.round((minorI + majorI) / 2);
    if (mediumI <= minorI || mediumI >= majorI) mediumI = -1;
  }

  return {
    minor: STEPS[minorI],
    medium: mediumI >= 0 ? STEPS[mediumI] : null,
    major: majorI >= 0 ? STEPS[majorI] : null,
  };
}

let ghostPatternSeq = 0;

/** Ghost-band hatch appearance — tweak here (one place). */
const GHOST_HATCH = {
  token: '--level-warn', // amber, themed; falls back below if unresolved
  fallback: '#f59b1e',
  tile: 14, // px tile → spacing between the diagonal lines (bigger = further apart)
  width: 7, // line thickness — half the tile, so stripe and gap are equal
  lineOpacity: 0.15,
  fillOpacity: 0.035, // faint wash between the lines
};

/** Append the diagonal-hatch pattern to `g`, returning its `url(#…)`. */
function ghostHatch(g: Selection<SVGGElement, unknown, null, undefined>, styles: CSSStyleDeclaration): string {
  const color = styles.getPropertyValue(GHOST_HATCH.token).trim() || GHOST_HATCH.fallback;
  const { tile, width } = GHOST_HATCH;
  const id = `ghost-hatch-${ghostPatternSeq++}`;
  const pattern = g
    .append('defs')
    .append('pattern')
    .attr('id', id)
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('width', tile)
    .attr('height', tile)
    .attr('patternTransform', 'rotate(45)');
  pattern.append('rect').attr('width', tile).attr('height', tile).attr('fill', color).attr('fill-opacity', GHOST_HATCH.fillOpacity);
  // centered in the tile so the full stroke width renders (an edge line clips)
  pattern
    .append('line')
    .attr('x1', tile / 2)
    .attr('y1', 0)
    .attr('x2', tile / 2)
    .attr('y2', tile)
    .attr('stroke', color)
    .attr('stroke-opacity', GHOST_HATCH.lineOpacity)
    .attr('stroke-width', width);
  return `url(#${id})`;
}

/**
 * Draw the "unfulfilled working set" overlay (SPEC §7): a muted hatch band over
 * each time span where the working set isn't satisfied — metadata still
 * streaming in, or records the memory budget refused. Drawn as a chart-
 * background layer, so call it BEFORE the grid/bars; where a bar is also drawn
 * the hatch shows behind it (counts real, records absent), and where no bar
 * exists the hatch stands alone (loading).
 */
export function drawGhostBand(
  g: Selection<SVGGElement, unknown, null, undefined>,
  x: (d: Date) => number,
  spans: [number, number][],
  innerW: number,
  innerH: number,
  styles: CSSStyleDeclaration,
): void {
  if (spans.length === 0) return;
  const fill = ghostHatch(g, styles);
  const band = g.append('g').attr('class', 'ghost-band');
  for (const [a, b] of spans) {
    const x0 = Math.max(0, x(new Date(a)));
    const x1 = Math.min(innerW, x(new Date(b)));
    if (x1 - x0 < 0.5) continue;
    band
      .append('rect')
      .attr('x', x0)
      .attr('y', 0)
      .attr('width', x1 - x0)
      .attr('height', innerH)
      .attr('fill', fill);
  }
}

/**
 * Full-panel ghost wash — the same hatch over the whole plot area, for a chart
 * with no time axis (the duration histogram) whose entire distribution is built
 * on an unfulfilled (partial, over-budget) instance set. Call before the bars.
 */
export function drawGhostFill(
  g: Selection<SVGGElement, unknown, null, undefined>,
  innerW: number,
  innerH: number,
  styles: CSSStyleDeclaration,
): void {
  g.append('rect')
    .attr('class', 'ghost-fill')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', innerW)
    .attr('height', innerH)
    .attr('fill', ghostHatch(g, styles));
}

/** Round `t` down to the start of its step boundary. */
function startOf(t: number, step: Step, utc: boolean): number {
  const d = new Date(t);
  if (utc) {
    switch (step.level) {
      case 'second':
        d.setUTCMilliseconds(0);
        d.setUTCSeconds(Math.floor(d.getUTCSeconds() / step.mult) * step.mult);
        break;
      case 'minute':
        d.setUTCSeconds(0, 0);
        d.setUTCMinutes(Math.floor(d.getUTCMinutes() / step.mult) * step.mult);
        break;
      case 'hour':
        d.setUTCMinutes(0, 0, 0);
        d.setUTCHours(Math.floor(d.getUTCHours() / step.mult) * step.mult);
        break;
      case 'day':
        d.setUTCHours(0, 0, 0, 0);
        break;
      case 'week':
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
        break;
      case 'month':
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(1);
        break;
      case 'year':
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCMonth(0, 1);
        break;
    }
  } else {
    switch (step.level) {
      case 'second':
        d.setMilliseconds(0);
        d.setSeconds(Math.floor(d.getSeconds() / step.mult) * step.mult);
        break;
      case 'minute':
        d.setSeconds(0, 0);
        d.setMinutes(Math.floor(d.getMinutes() / step.mult) * step.mult);
        break;
      case 'hour':
        d.setMinutes(0, 0, 0);
        d.setHours(Math.floor(d.getHours() / step.mult) * step.mult);
        break;
      case 'day':
        d.setHours(0, 0, 0, 0);
        break;
      case 'week':
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        break;
      case 'month':
        d.setHours(0, 0, 0, 0);
        d.setDate(1);
        break;
      case 'year':
        d.setHours(0, 0, 0, 0);
        d.setMonth(0, 1);
        break;
    }
  }
  return d.getTime();
}

/** Advance one step — calendar-correct across DST and uneven months. */
function advance(t: number, step: Step, utc: boolean): number {
  const d = new Date(t);
  switch (step.level) {
    case 'second':
      utc ? d.setUTCSeconds(d.getUTCSeconds() + step.mult) : d.setSeconds(d.getSeconds() + step.mult);
      break;
    case 'minute':
      utc ? d.setUTCMinutes(d.getUTCMinutes() + step.mult) : d.setMinutes(d.getMinutes() + step.mult);
      break;
    case 'hour':
      utc ? d.setUTCHours(d.getUTCHours() + step.mult) : d.setHours(d.getHours() + step.mult);
      break;
    case 'day':
      utc ? d.setUTCDate(d.getUTCDate() + 1) : d.setDate(d.getDate() + 1);
      break;
    case 'week':
      utc ? d.setUTCDate(d.getUTCDate() + 7) : d.setDate(d.getDate() + 7);
      break;
    case 'month':
      utc ? d.setUTCMonth(d.getUTCMonth() + 1) : d.setMonth(d.getMonth() + 1);
      break;
    case 'year':
      utc ? d.setUTCFullYear(d.getUTCFullYear() + 1) : d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.getTime();
}

/** The coarsest meaningful boundary `t` lands on — used for humane labels. */
export function levelOf(t: number, utc: boolean): TimeLevel {
  const d = new Date(t);
  const ms = utc ? d.getUTCMilliseconds() : d.getMilliseconds();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const h = utc ? d.getUTCHours() : d.getHours();
  if (ms !== 0 || s !== 0) return 'second';
  if (mi !== 0) return 'minute';
  if (h !== 0) return 'hour';
  const date = utc ? d.getUTCDate() : d.getDate();
  const mon = utc ? d.getUTCMonth() : d.getMonth();
  const dow = utc ? d.getUTCDay() : d.getDay();
  if (mon === 0 && date === 1) return 'year';
  if (date === 1) return 'month';
  if (dow === 1) return 'week';
  return 'day';
}

/** Every step boundary within `[t0, t1]`, inclusive. */
function ticksFor(t0: number, t1: number, step: Step, utc: boolean): number[] {
  const out: number[] = [];
  let t = startOf(t0, step, utc);
  if (t < t0) t = advance(t, step, utc);
  // guard against a pathological domain producing an unbounded loop
  for (let i = 0; t <= t1 && i < 100_000; i++) {
    out.push(t);
    t = advance(t, step, utc);
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Humane label for a tick, formatted in `level`'s unit. `prevMonthKey` lets
 * day labels drop a repeated month ("Jun 9", then "10", "11"…), reintroducing
 * it at each month boundary.
 */
export function formatTick(
  t: number,
  level: TimeLevel,
  utc: boolean,
  prevMonthKey: string,
): { text: string; monthKey: string } {
  const d = new Date(t);
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const Mo = utc ? d.getUTCMonth() : d.getMonth();
  const Da = utc ? d.getUTCDate() : d.getDate();
  const H = utc ? d.getUTCHours() : d.getHours();
  const Mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const S = utc ? d.getUTCSeconds() : d.getSeconds();
  const monthKey = `${Y}-${Mo}`;
  switch (level) {
    case 'year':
      return { text: `${Y}`, monthKey };
    case 'month':
      return { text: MONTHS[Mo], monthKey };
    case 'week':
    case 'day':
      return { text: monthKey === prevMonthKey ? `${Da}` : `${MONTHS[Mo]} ${Da}`, monthKey };
    case 'hour':
      return { text: `${pad2(H)}:00`, monthKey };
    case 'minute':
      return { text: `${pad2(H)}:${pad2(Mi)}`, monthKey };
    case 'second':
      return { text: `${pad2(H)}:${pad2(Mi)}:${pad2(S)}`, monthKey };
  }
}

/**
 * Draw the background gridlines, baseline, and labels into `g`. Call this
 * BEFORE drawing bars/lines/points so the grid sits behind them. Top labels
 * are placed at y = -6 (in the chart's top margin), so the host needs a top
 * margin of ≥ ~16.
 */
export function drawTimeGrid(
  g: Selection<SVGGElement, unknown, null, undefined>,
  x: (d: Date) => number,
  domain: [number, number],
  innerW: number,
  innerH: number,
  styles: CSSStyleDeclaration,
  /** bar width, when this is a bar chart: minor lines never subdivide a bar */
  bucketMs?: number,
): void {
  const span = domain[1] - domain[0];
  if (!(span > 0)) return;
  const utc = isUtcMode();
  const ink = styles.getPropertyValue('--ink').trim() || '#000';
  const baseColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const inkSoft = styles.getPropertyValue('--ink-soft').trim();

  const { minor, medium, major } = chooseTiers(domain, innerW, bucketMs, utc);
  const onScreen = (gx: number): boolean => gx >= -0.5 && gx <= innerW + 0.5;

  // ── gridlines, weighted by tier rank (coarser tier wins at shared marks) ──
  const tierOf = new Map<number, keyof typeof TIER_OPACITY>();
  for (const t of ticksFor(domain[0], domain[1], minor, utc)) tierOf.set(t, 'minor');
  if (medium) for (const t of ticksFor(domain[0], domain[1], medium, utc)) tierOf.set(t, 'medium');
  if (major) for (const t of ticksFor(domain[0], domain[1], major, utc)) tierOf.set(t, 'major');

  const grid = g.append('g').attr('class', 'time-grid');
  for (const [t, tier] of tierOf) {
    const gx = x(new Date(t));
    if (!onScreen(gx)) continue;
    grid
      .append('line')
      .attr('x1', gx)
      .attr('x2', gx)
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', ink)
      .attr('stroke-opacity', TIER_OPACITY[tier])
      .attr('shape-rendering', 'crispEdges');
  }
  grid
    .append('line')
    .attr('x1', 0)
    .attr('x2', innerW)
    .attr('y1', innerH)
    .attr('y2', innerH)
    .attr('stroke', baseColor);

  // ── top labels: the coarse DATE anchor, to the right of its line, grey to
  //    match the line's prominence (major darker, medium lighter) ──
  const topMarks = new Set<number>();
  const topG = g.append('g');
  const drawTop = (step: Step, color: string): void => {
    let prev = '';
    for (const t of ticksFor(domain[0], domain[1], step, utc)) {
      if (topMarks.has(t)) continue;
      const gx = x(new Date(t));
      if (!onScreen(gx)) continue;
      topMarks.add(t);
      const { text, monthKey } = formatTick(t, step.level, utc, prev);
      prev = monthKey;
      const atRight = gx > innerW - 34;
      topG
        .append('text')
        .attr('x', atRight ? gx - 4 : gx + 4)
        .attr('y', -6)
        .attr('text-anchor', atRight ? 'end' : 'start')
        .attr('fill', color)
        .style('font', '10.5px var(--font-data)')
        .text(text);
    }
  };
  if (major && !isTime(major.level)) drawTop(major, inkSoft);
  if (medium && !isTime(medium.level)) drawTop(medium, inkFaint);

  // ── bottom labels: the running fine times (the medium marks when those are
  //    sub-day, else minor), thinned for legibility; a mark whose date is
  //    already up top is skipped so no x carries two labels ──
  const bottomStep = medium && isTime(medium.level) ? medium : minor;
  const bottomG = g.append('g').attr('transform', `translate(0,${innerH})`);
  let lastX = -Infinity;
  let prevB = '';
  for (const t of ticksFor(domain[0], domain[1], bottomStep, utc)) {
    if (topMarks.has(t)) continue;
    const gx = x(new Date(t));
    if (!onScreen(gx)) continue;
    if (gx - lastX < BOTTOM_LABEL_PX) continue;
    lastX = gx;
    const { text, monthKey } = formatTick(t, minor.level, utc, prevB);
    prevB = monthKey;
    bottomG
      .append('text')
      .attr('x', gx)
      .attr('y', 12)
      .attr('text-anchor', 'middle')
      .attr('fill', inkFaint)
      .style('font', '10.5px var(--font-data)')
      .text(text);
  }
}
