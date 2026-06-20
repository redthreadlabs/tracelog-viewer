/**
 * Pure aggregation helpers for the overview: time-period volume and
 * per-transaction-name rollups. No DOM, no D3 — unit-testable.
 */
import type { Rec } from './types';
import { rangeSlice } from './store';

/** Candidate period widths, smallest first. */
export const PERIOD_STEPS_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  3 * 3_600_000,
  6 * 3_600_000,
  24 * 3_600_000, // 1d
];

const TARGET_MAX_PERIODS = 120;

/** A user-chosen width may not produce more periods than this. */
const HARD_MAX_PERIODS = 1500;

export function choosePeriodMs(spanMs: number): number {
  for (const step of PERIOD_STEPS_MS) {
    if (spanMs / step <= TARGET_MAX_PERIODS) return step;
  }
  return PERIOD_STEPS_MS[PERIOD_STEPS_MS.length - 1];
}

/**
 * Resolve the effective period width: an explicit choice is honored unless
 * it would produce an absurd number of periods for the span (1m periods over a
 * month), in which case it escalates to the smallest sane step.
 */
export function resolvePeriodMs(spanMs: number, chosenMs: number | null): number {
  if (chosenMs === null) return choosePeriodMs(spanMs);
  let ms = chosenMs;
  for (const step of PERIOD_STEPS_MS) {
    if (step < ms) continue;
    ms = step;
    if (spanMs / ms <= HARD_MAX_PERIODS) return ms;
  }
  return PERIOD_STEPS_MS[PERIOD_STEPS_MS.length - 1];
}

/**
 * Midnight of `ms` in the active display zone — the anchor every period grid
 * hangs off. Aligning to the zone's midnight (not the raw epoch) makes calendar
 * boundaries — local midnight, the 1st of a month — fall on bar edges, so the
 * time grid lines up with the bars instead of drifting by the sub-period
 * timezone remainder. Every PERIOD_STEPS_MS width divides a day, so each day's
 * midnight is itself a period boundary. Uniform-ms stepping from the anchor
 * keeps period assignment O(1); the only cost is a ≤1h drift across a DST
 * transition on multi-day ranges (bounded and rare). With `utc=true` the anchor
 * is a whole number of days from the epoch — a multiple of every period width —
 * so the grid reduces exactly to the old epoch alignment.
 */
export function zoneMidnight(ms: number, utc: boolean): number {
  const d = new Date(ms);
  if (utc) d.setUTCHours(0, 0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The period grid for a [min, max] span: resolves the width, anchors to the
 * zone midnight, and returns the aligned domain + period count. Shared by every
 * aggregator so the alignment + exclusive-windowed-end rules live in one place.
 * A windowed end is exclusive (round UP, so a range ending on a period edge adds
 * no empty trailing period); without a range the end includes the last point's
 * own period.
 */
export function periodGrid(
  min: number,
  max: number,
  range: [number, number] | null,
  chosenPeriodMs: number | null,
  utc: boolean,
): { start: number; end: number; periodMs: number; n: number } {
  const periodMs = resolvePeriodMs(Math.max(max - min, 1), chosenPeriodMs);
  const anchor = zoneMidnight(min, utc);
  const start = anchor + Math.floor((min - anchor) / periodMs) * periodMs;
  let end = range
    ? anchor + Math.ceil((max - anchor) / periodMs) * periodMs
    : anchor + Math.floor((max - anchor) / periodMs) * periodMs + periodMs;
  if (end <= start) end = start + periodMs; // at least one period
  const n = Math.round((end - start) / periodMs);
  return { start, end, periodMs, n };
}

// ---------- generalized series aggregation (SPEC §11) ----------

export interface SeriesPeriod {
  /** period start, epoch-ms */
  t0: number;
  /** series key → aggregated value (e.g. transaction name → Σ duration) */
  values: Record<string, number>;
  /** sum of values across series — the bar height */
  total: number;
}

export interface SeriesResult {
  periods: SeriesPeriod[];
  /** the series, in stack/legend order: top groups by total descending, then
   *  `otherLabel` last when the tail was folded */
  series: string[];
  periodMs: number;
  /** [domainStart, domainEnd] epoch-ms, period-aligned */
  domain: [number, number];
}

export interface SeriesSpec {
  /** a record's contribution to its group (count → 1, sum(duration) → r.duration) */
  value: (r: Rec) => number;
  /** the group/series a record belongs to (e.g. r => r.name) */
  group: (r: Rec) => string;
  /** which records participate (others ignored) */
  include?: (r: Rec) => boolean;
  /** keep this many top groups by total; the rest fold into `otherLabel` */
  topN: number;
  /** label for the folded tail (default 'Other') */
  otherLabel?: string;
  /** drop the non-top-N tail entirely instead of folding it into `otherLabel`
   *  — the chart shows only the top-N (or the explicitly-`include`d set). */
  noOther?: boolean;
}

/**
 * A pre-aggregated contribution to the series: a group (`name`) gets `weight`
 * added at time `t`. Lets an index supply already-rolled-up points (e.g. an
 * hour's Σ duration for a transaction) into the same periods as raw records —
 * the solver merges index + records through this (SPEC §11).
 */
export interface WeightedPoint {
  name: string;
  t: number;
  weight: number;
}

/**
 * Aggregate a metric over time periods, broken out by an arbitrary grouping
 * dimension and reduced to the top-N groups (by total over the window) plus an
 * "Other" roll-up. The two-pass shape (rank, then aggregate) keeps the stack
 * readable regardless of group cardinality. `extra` folds in pre-aggregated
 * points (from an index) alongside the raw records, into the same ranking and
 * periods. Pure.
 */
export function aggregateBySeries(
  records: Rec[],
  range: [number, number] | null,
  chosenPeriodMs: number | null,
  utc: boolean,
  spec: SeriesSpec,
  extra: WeightedPoint[] = [],
): SeriesResult {
  const otherLabel = spec.otherLabel ?? 'Other';
  const include = spec.include ?? (() => true);
  records = rangeSlice(records, range); // O(log n) on the sorted store

  let min = Infinity;
  let max = -Infinity;
  for (const r of records) {
    if (!include(r) || r.ts <= 0) continue;
    if (r.ts < min) min = r.ts;
    if (r.ts > max) max = r.ts;
  }
  for (const p of extra) {
    if (p.t <= 0) continue;
    if (p.t < min) min = p.t;
    if (p.t > max) max = p.t;
  }
  if (range) {
    min = range[0];
    max = range[1];
  }
  if (!isFinite(min) || !isFinite(max) || max < min) {
    return { periods: [], series: [], periodMs: 60_000, domain: [0, 0] };
  }

  const { start, end, periodMs, n } = periodGrid(min, max, range ?? null, chosenPeriodMs, utc);
  const inWindow = (r: Rec) => include(r) && r.ts >= start && r.ts < end;
  const pInWindow = (p: WeightedPoint) => p.t >= start && p.t < end;

  // pass 1: rank the included groups by total over the window, keep the top N
  const totals = new Map<string, number>();
  for (const r of records) {
    if (!inWindow(r)) continue;
    const g = spec.group(r);
    totals.set(g, (totals.get(g) ?? 0) + spec.value(r));
  }
  for (const p of extra) {
    if (!pInWindow(p)) continue;
    totals.set(p.name, (totals.get(p.name) ?? 0) + p.weight);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, spec.topN).map(([g]) => g);
  const topSet = new Set(top);
  const series = ranked.length > spec.topN && !spec.noOther ? [...top, otherLabel] : top;

  // pass 2: period. The tail (non-top-N) folds into Other, or is dropped
  // entirely when noOther.
  const periods: SeriesPeriod[] = Array.from({ length: n }, (_, i) => ({
    t0: start + i * periodMs,
    values: {},
    total: 0,
  }));
  const add = (key: string, t: number, v: number): void => {
    const b = periods[Math.floor((t - start) / periodMs)];
    b.values[key] = (b.values[key] ?? 0) + v;
    b.total += v;
  };
  for (const r of records) {
    if (!inWindow(r)) continue;
    const g = spec.group(r);
    const inTop = topSet.has(g);
    if (!inTop && spec.noOther) continue; // tail dropped, not folded
    const v = spec.value(r);
    if (v === 0) continue; // a zero contribution changes neither stack nor height
    add(inTop ? g : otherLabel, r.ts, v);
  }
  for (const p of extra) {
    if (!pInWindow(p)) continue;
    const inTop = topSet.has(p.name);
    if (!inTop && spec.noOther) continue;
    if (p.weight === 0) continue;
    add(inTop ? p.name : otherLabel, p.t, p.weight);
  }

  return { periods, series, periodMs, domain: [start, end] };
}

/** `blankPartialPeriods` for the series shape: zero any period overlapping a
 *  partially-loaded span, so a records-path series chart never shows a
 *  misleadingly short bar for an interval still missing files. */
export function blankPartialSeries(
  result: SeriesResult,
  incompleteSpans: [number, number][],
): SeriesResult {
  if (incompleteSpans.length === 0) return result;
  const periods = result.periods.map((b) => {
    const t1 = b.t0 + result.periodMs;
    const partial = incompleteSpans.some(([s0, s1]) => s0 < t1 && s1 > b.t0);
    return partial ? { t0: b.t0, values: {}, total: 0 } : b;
  });
  return { ...result, periods };
}

export type ResultFamily = 'ok' | 'warn' | 'bad' | 'other';

/** Classify a transaction's result/outcome into a coarse family. */
export function resultFamily(rec: Rec): ResultFamily {
  const result = (rec.result ?? '').toLowerCase();
  const outcome = (rec.outcome ?? '').toLowerCase();
  if (result.startsWith('http 4')) return 'warn';
  if (result.startsWith('http 5') || result === 'error' || result === 'failure') return 'bad';
  if (outcome === 'failure') return 'bad';
  if (result.startsWith('http 2') || result.startsWith('http 3') || result === 'success') {
    return 'ok';
  }
  if (outcome === 'success') return 'ok';
  return 'other';
}

export interface TxnGroup {
  name: string;
  count: number;
  /** ms */
  totalDuration: number;
  /** ms */
  avg?: number;
  /** ms */
  p95?: number;
  /** instances whose result family is 'bad' (5xx / error / failure) */
  errors: number;
}

export type TxnSortKey = 'name' | 'count' | 'totalDuration' | 'avg' | 'p95' | 'errors';

export function groupTransactions(
  records: Rec[],
  range?: [number, number] | null,
): TxnGroup[] {
  const groups = new Map<string, TxnGroup & { durations: number[] }>();
  for (const r of rangeSlice(records, range)) {
    if (r.kind !== 'transaction') continue;
    let group = groups.get(r.name);
    if (!group) {
      group = { name: r.name, count: 0, totalDuration: 0, errors: 0, durations: [] };
      groups.set(r.name, group);
    }
    group.count++;
    group.totalDuration += r.duration ?? 0;
    if (r.duration !== undefined) group.durations.push(r.duration);
    if (resultFamily(r) === 'bad') group.errors++;
  }
  return [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b);
    return {
      ...group,
      avg: durations.length > 0 ? group.totalDuration / durations.length : undefined,
      p95: percentile(durations, 95),
    };
  });
}

export function sortTxnGroups(groups: TxnGroup[], key: TxnSortKey, desc: boolean): TxnGroup[] {
  const sorted = [...groups].sort((a, b) =>
    key === 'name' ? a.name.localeCompare(b.name) : (a[key] ?? 0) - (b[key] ?? 0),
  );
  if (desc) sorted.reverse();
  return sorted;
}

// ---------- per-transaction drill-down ----------

export interface TxnStats {
  name: string;
  count: number;
  /** all instances of the named transaction, time-ordered */
  instances: Rec[];
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  /** result string → count (e.g. 'HTTP 2xx' → 412) */
  resultCounts: Map<string, number>;
  /** requests per minute over the observed span */
  rpm?: number;
}

export function transactionStats(
  records: Rec[],
  name: string,
  range?: [number, number] | null,
): TxnStats {
  const instances = rangeSlice(records, range)
    .filter((r) => r.kind === 'transaction' && r.name === name)
    .sort((a, b) => a.ts - b.ts);

  const durations = instances
    .map((r) => r.duration)
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  const resultCounts = new Map<string, number>();
  for (const r of instances) {
    const key = r.result ?? r.outcome ?? 'unknown';
    resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
  }

  let rpm: number | undefined;
  if (instances.length >= 2) {
    const spanMs = instances[instances.length - 1].ts - instances[0].ts;
    if (spanMs > 0) rpm = instances.length / (spanMs / 60_000);
  }

  return {
    name,
    count: instances.length,
    instances,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1],
    resultCounts,
    rpm,
  };
}

/** Linear-interpolated percentile of an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export interface HistBin {
  /** bin bounds, ms */
  x0: number;
  x1: number;
  count: number;
}

/**
 * Log-spaced duration histogram — request durations are heavy-tailed, so
 * linear bins put everything in the first bar. Zero/sub-10µs durations are
 * clamped into the lowest bin.
 */
export function logHistogram(durations: number[], binCount = 24): HistBin[] {
  if (durations.length === 0) return [];
  const MIN = 0.01; // 10µs floor
  // a loop, not Math.max(...durations): spreading puts every element on
  // the call stack, which overflows past ~100k instances
  let max = MIN * 10;
  for (const d of durations) if (d > max) max = d;
  const lo = Math.log10(MIN);
  const hi = Math.log10(max * 1.001);
  const step = (hi - lo) / binCount;

  const bins: HistBin[] = Array.from({ length: binCount }, (_, i) => ({
    x0: Math.pow(10, lo + i * step),
    x1: Math.pow(10, lo + (i + 1) * step),
    count: 0,
  }));

  for (const d of durations) {
    const clamped = Math.max(d, MIN);
    let idx = Math.floor((Math.log10(clamped) - lo) / step);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  return bins;
}
