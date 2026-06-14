/**
 * Shared time-axis grid for every time-series chart (timebars, stackbars,
 * line, scatter). Replaces d3's multi-scale axis with calendar-aware
 * gridlines whose prominence tracks the *significance* of the boundary they
 * fall on: a faint hour line, a stronger midnight (day) line, stronger still
 * a Monday (week), a month's 1st, a year's Jan 1. The eye reads the time
 * structure straight from the background.
 *
 * Two steps are chosen for the visible span+width: a dense MINOR step (the
 * gridlines) and a sparser LABEL step (which lines get a humane label). Every
 * line's opacity comes from its own significance, so the hierarchy emerges
 * for free wherever coarser boundaries happen to coincide with the grid.
 */
import type { Selection } from 'd3-selection';
import { isUtcMode } from '../ui/format';

export type TimeLevel = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/** Faint grey, deepening with significance — month reads stronger than day. */
const LEVEL_OPACITY: Record<TimeLevel, number> = {
  second: 0.045,
  minute: 0.06,
  hour: 0.085,
  day: 0.13,
  week: 0.17,
  month: 0.24,
  year: 0.32,
};

interface Step {
  /** approximate span, only used to choose density */
  ms: number;
  /** calendar unit the step advances by */
  level: Exclude<TimeLevel, never>;
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

const MIN_MINOR_PX = 11; // gridlines no closer than this
const MIN_LABEL_PX = 72; // labels no closer than this

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Densest ladder step whose on-screen spacing clears `minPx` (else coarsest). */
function pickStep(span: number, innerW: number, minPx: number): Step {
  for (const step of STEPS) {
    if ((innerW * step.ms) / span >= minPx) return step;
  }
  return STEPS[STEPS.length - 1];
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

/** The coarsest meaningful boundary `t` lands on — drives its prominence. */
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
 * Humane label for a labelled tick, formatted in the unit it represents.
 * `prevMonthKey` lets day/week labels drop a repeated month ("Jun 9", then
 * just "10", "11"…), reintroducing it at each month boundary.
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
 * Draw the background gridlines, baseline, and bottom labels into `g`.
 * Call this BEFORE drawing bars/lines/points so the grid sits behind them.
 * The y-axis is left to each chart (this owns the time axis only).
 */
export function drawTimeGrid(
  g: Selection<SVGGElement, unknown, null, undefined>,
  x: (d: Date) => number,
  domain: [number, number],
  innerW: number,
  innerH: number,
  styles: CSSStyleDeclaration,
  /** bar width, when this is a bar chart: gridlines never subdivide a bar */
  bucketMs?: number,
): void {
  const span = domain[1] - domain[0];
  if (!(span > 0)) return;
  const utc = isUtcMode();
  const ink = styles.getPropertyValue('--ink').trim() || '#000';
  const baseColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const inkSoft = styles.getPropertyValue('--ink-soft').trim();

  let minorStep = pickStep(span, innerW, MIN_MINOR_PX);
  // On a bar chart, never draw a gridline finer than the bars — a sub-bar line
  // would cut through a bar instead of sitting on a bucket edge. (bucketMs is
  // a BUCKET_STEPS_MS value, all of which are on the ladder.)
  if (bucketMs) {
    const barStep = STEPS.find((s) => s.ms >= bucketMs) ?? STEPS[STEPS.length - 1];
    if (STEPS.indexOf(barStep) > STEPS.indexOf(minorStep)) minorStep = barStep;
  }
  let labelStep = pickStep(span, innerW, MIN_LABEL_PX);
  if (STEPS.indexOf(labelStep) < STEPS.indexOf(minorStep)) labelStep = minorStep;

  const minorTimes = ticksFor(domain[0], domain[1], minorStep, utc);
  const labelTimes = ticksFor(domain[0], domain[1], labelStep, utc);

  // gridlines: union of minor + label boundaries (month 1sts aren't on the
  // weekly grid, etc.), each weighted by its own significance
  const gridTimes = Array.from(new Set([...minorTimes, ...labelTimes])).sort((a, b) => a - b);
  const grid = g.append('g').attr('class', 'time-grid');
  for (const t of gridTimes) {
    const gx = x(new Date(t));
    if (gx < -0.5 || gx > innerW + 0.5) continue;
    grid
      .append('line')
      .attr('x1', gx)
      .attr('x2', gx)
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', ink)
      .attr('stroke-opacity', LEVEL_OPACITY[levelOf(t, utc)])
      .attr('shape-rendering', 'crispEdges');
  }

  // baseline along the bottom
  grid
    .append('line')
    .attr('x1', 0)
    .attr('x2', innerW)
    .attr('y1', innerH)
    .attr('y2', innerH)
    .attr('stroke', baseColor);

  // labels below the baseline, in the unit each tick represents. Calendar
  // labels (day and up) anchor the row in darker, semibold ink; sub-day times
  // recede in faint ink — so a mixed row reads as dates with subordinate times
  // ("Jun 3 · 12:00 · 4 · 12:00 · 5") rather than an even mishmash.
  const labelG = g.append('g').attr('transform', `translate(0,${innerH})`);
  let prevMonthKey = '';
  for (const t of labelTimes) {
    const gx = x(new Date(t));
    if (gx < -0.5 || gx > innerW + 0.5) continue;
    const level = levelOf(t, utc);
    const { text, monthKey } = formatTick(t, level, utc, prevMonthKey);
    prevMonthKey = monthKey;
    const calendar = level !== 'hour' && level !== 'minute' && level !== 'second';
    labelG
      .append('text')
      .attr('x', gx)
      .attr('y', 12)
      .attr('text-anchor', 'middle')
      .attr('fill', calendar ? inkSoft : inkFaint)
      .style('font', `${calendar ? 600 : 400} 10.5px var(--font-data)`)
      .text(text);
  }
}
