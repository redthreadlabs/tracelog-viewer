/**
 * Pure aggregation helpers for the overview: time-bucketed volume and
 * per-transaction-name rollups. No DOM, no D3 — unit-testable.
 */
import type { Rec, RecordKind } from './types';
import { rangeSlice } from './store';

export interface TimeBucket {
  /** bucket start, epoch-ms */
  t0: number;
  counts: Partial<Record<RecordKind, number>>;
  total: number;
}

export interface BucketResult {
  buckets: TimeBucket[];
  bucketMs: number;
  /** [domainStart, domainEnd] epoch-ms, bucket-aligned */
  domain: [number, number];
}

/** Candidate bucket widths, smallest first. */
export const BUCKET_STEPS_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  3 * 3_600_000,
  6 * 3_600_000,
  24 * 3_600_000, // 1d
];

const TARGET_MAX_BUCKETS = 120;

/** A user-chosen width may not produce more bars than this. */
const HARD_MAX_BUCKETS = 1500;

export function chooseBucketMs(spanMs: number): number {
  for (const step of BUCKET_STEPS_MS) {
    if (spanMs / step <= TARGET_MAX_BUCKETS) return step;
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

/**
 * Resolve the effective bucket width: an explicit choice is honored unless
 * it would produce an absurd number of bars for the span (1m bars over a
 * month), in which case it escalates to the smallest sane step.
 */
export function resolveBucketMs(spanMs: number, chosenMs: number | null): number {
  if (chosenMs === null) return chooseBucketMs(spanMs);
  let ms = chosenMs;
  for (const step of BUCKET_STEPS_MS) {
    if (step < ms) continue;
    ms = step;
    if (spanMs / ms <= HARD_MAX_BUCKETS) return ms;
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

/**
 * Midnight of `ms` in the active display zone — the anchor every bucket grid
 * hangs off. Aligning to the zone's midnight (not the raw epoch) makes calendar
 * boundaries — local midnight, the 1st of a month — fall on bar edges, so the
 * time grid lines up with the bars instead of drifting by the sub-bucket
 * timezone remainder. Every BUCKET_STEPS_MS width divides a day, so each day's
 * midnight is itself a bucket boundary. Uniform-ms stepping from the anchor
 * keeps bucket assignment O(1); the only cost is a ≤1h drift across a DST
 * transition on multi-day ranges (bounded and rare). With `utc=true` the anchor
 * is a whole number of days from the epoch — a multiple of every bucket width —
 * so the grid reduces exactly to the old epoch alignment.
 */
export function zoneMidnight(ms: number, utc: boolean): number {
  const d = new Date(ms);
  if (utc) d.setUTCHours(0, 0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The bucket grid for a [min, max] span: resolves the width, anchors to the
 * zone midnight, and returns the aligned domain + bucket count. Shared by every
 * bucketer so the alignment + exclusive-windowed-end rules live in one place.
 * A windowed end is exclusive (round UP, so a range ending on a bucket edge adds
 * no empty trailing bucket); without a range the end includes the last point's
 * own bucket.
 */
export function bucketGrid(
  min: number,
  max: number,
  range: [number, number] | null,
  chosenBucketMs: number | null,
  utc: boolean,
): { start: number; end: number; bucketMs: number; n: number } {
  const bucketMs = resolveBucketMs(Math.max(max - min, 1), chosenBucketMs);
  const anchor = zoneMidnight(min, utc);
  const start = anchor + Math.floor((min - anchor) / bucketMs) * bucketMs;
  let end = range
    ? anchor + Math.ceil((max - anchor) / bucketMs) * bucketMs
    : anchor + Math.floor((max - anchor) / bucketMs) * bucketMs + bucketMs;
  if (end <= start) end = start + bucketMs; // at least one bucket
  const n = Math.round((end - start) / bucketMs);
  return { start, end, bucketMs, n };
}

export function bucketByTime(
  records: Rec[],
  range?: [number, number] | null,
  chosenBucketMs: number | null = null,
  utc = true,
): BucketResult {
  records = rangeSlice(records, range); // O(log n) on the sorted store
  let min = Infinity;
  let max = -Infinity;
  for (const r of records) {
    if (r.ts <= 0) continue;
    if (r.ts < min) min = r.ts;
    if (r.ts > max) max = r.ts;
  }
  if (range) {
    min = range[0];
    max = range[1];
  }
  if (!isFinite(min) || !isFinite(max) || max < min) {
    return { buckets: [], bucketMs: 60_000, domain: [0, 0] };
  }

  const { start, end, bucketMs, n } = bucketGrid(min, max, range ?? null, chosenBucketMs, utc);

  const buckets: TimeBucket[] = Array.from({ length: n }, (_, i) => ({
    t0: start + i * bucketMs,
    counts: {},
    total: 0,
  }));

  for (const r of records) {
    if (r.ts < start || r.ts >= end) continue;
    const bucket = buckets[Math.floor((r.ts - start) / bucketMs)];
    bucket.counts[r.kind] = (bucket.counts[r.kind] ?? 0) + 1;
    bucket.total++;
  }

  return { buckets, bucketMs, domain: [start, end] };
}

/**
 * Blank (zero) any bucket overlapping a time span whose data is only partially
 * loaded, so a records-path chart never shows a misleadingly short bar for an
 * interval still missing files — an interval is either fully populated or left
 * blank. `incompleteSpans` are [startMs, endMs) ranges of intervals whose files
 * aren't all loaded. The bucketed input is returned unchanged when nothing is
 * partial. (The metadata path is always complete, so it doesn't need this.)
 */
export function blankPartialBuckets(
  result: BucketResult,
  incompleteSpans: [number, number][],
): BucketResult {
  if (incompleteSpans.length === 0) return result;
  const buckets = result.buckets.map((b) => {
    const t1 = b.t0 + result.bucketMs;
    const partial = incompleteSpans.some(([s0, s1]) => s0 < t1 && s1 > b.t0);
    return partial ? { t0: b.t0, counts: {}, total: 0 } : b;
  });
  return { ...result, buckets };
}

// ---------- generalized series aggregation (SPEC §11) ----------

export interface SeriesBucket {
  /** bucket start, epoch-ms */
  t0: number;
  /** series key → aggregated value (e.g. transaction name → Σ duration) */
  values: Record<string, number>;
  /** sum of values across series — the bar height */
  total: number;
}

export interface SeriesResult {
  buckets: SeriesBucket[];
  /** the series, in stack/legend order: top groups by total descending, then
   *  `otherLabel` last when the tail was folded */
  series: string[];
  bucketMs: number;
  /** [domainStart, domainEnd] epoch-ms, bucket-aligned */
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
}

/**
 * Time-bucket a metric, broken out by an arbitrary grouping dimension and
 * reduced to the top-N groups (by total over the window) plus an "Other" roll-up
 * — the generalized cousin of `bucketByTime`. The two-pass shape (rank, then
 * bucket) keeps the stack readable regardless of group cardinality. Pure.
 */
export function aggregateBySeries(
  records: Rec[],
  range: [number, number] | null,
  chosenBucketMs: number | null,
  utc: boolean,
  spec: SeriesSpec,
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
  if (range) {
    min = range[0];
    max = range[1];
  }
  if (!isFinite(min) || !isFinite(max) || max < min) {
    return { buckets: [], series: [], bucketMs: 60_000, domain: [0, 0] };
  }

  const { start, end, bucketMs, n } = bucketGrid(min, max, range ?? null, chosenBucketMs, utc);
  const inWindow = (r: Rec) => include(r) && r.ts >= start && r.ts < end;

  // pass 1: rank groups by their total over the window, keep the top N
  const totals = new Map<string, number>();
  for (const r of records) {
    if (!inWindow(r)) continue;
    const g = spec.group(r);
    totals.set(g, (totals.get(g) ?? 0) + spec.value(r));
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, spec.topN).map(([g]) => g);
  const topSet = new Set(top);
  const series = ranked.length > spec.topN ? [...top, otherLabel] : top;

  // pass 2: bucket, folding non-top groups into Other
  const buckets: SeriesBucket[] = Array.from({ length: n }, (_, i) => ({
    t0: start + i * bucketMs,
    values: {},
    total: 0,
  }));
  for (const r of records) {
    if (!inWindow(r)) continue;
    const v = spec.value(r);
    if (v === 0) continue; // a zero contribution changes neither stack nor height
    const key = topSet.has(spec.group(r)) ? spec.group(r) : otherLabel;
    const b = buckets[Math.floor((r.ts - start) / bucketMs)];
    b.values[key] = (b.values[key] ?? 0) + v;
    b.total += v;
  }

  return { buckets, series, bucketMs, domain: [start, end] };
}

/** `blankPartialBuckets` for the series shape: zero any bucket overlapping a
 *  partially-loaded span, so a records-path series chart never shows a
 *  misleadingly short bar for an interval still missing files. */
export function blankPartialSeries(
  result: SeriesResult,
  incompleteSpans: [number, number][],
): SeriesResult {
  if (incompleteSpans.length === 0) return result;
  const buckets = result.buckets.map((b) => {
    const t1 = b.t0 + result.bucketMs;
    const partial = incompleteSpans.some(([s0, s1]) => s0 < t1 && s1 > b.t0);
    return partial ? { t0: b.t0, values: {}, total: 0 } : b;
  });
  return { ...result, buckets };
}

const HOUR_MS = 3_600_000;

/** Parse a sidecar hour label 'YYYY-MM-DDTHH' to epoch-ms (UTC), or null. */
function hourLabelToMs(label: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(label);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

/**
 * Build the volume chart from sidecar histograms instead of records. The
 * histograms are hourly (`{ 'YYYY-MM-DDTHH': { kind: count } }`), so this is
 * EXACT for any bucket ≥ 1h (the ≥1h `BUCKET_STEPS_MS` are clean hour
 * multiples). Returns null when the resolved bucket would be sub-hourly — the
 * caller must then fall back to bucketByTime over loaded records. Pure.
 */
export function bucketBySidecar(
  histograms: Record<string, Record<string, number>>[],
  range: [number, number] | null,
  chosenBucketMs: number | null = null,
  utc = true,
): BucketResult | null {
  // sum every file's hourly histogram into one hour → kind-counts map
  const byHour = new Map<number, Partial<Record<RecordKind, number>>>();
  let min = Infinity;
  let max = -Infinity;
  for (const hist of histograms) {
    for (const label in hist) {
      const t = hourLabelToMs(label);
      if (t === null) continue;
      if (range && (t >= range[1] || t + HOUR_MS <= range[0])) continue; // hour fully outside
      if (t < min) min = t;
      if (t > max) max = t;
      let counts = byHour.get(t);
      if (!counts) {
        counts = {};
        byHour.set(t, counts);
      }
      const kinds = hist[label];
      for (const k in kinds) {
        counts[k as RecordKind] = (counts[k as RecordKind] ?? 0) + kinds[k];
      }
    }
  }
  if (range) {
    min = range[0];
    max = range[1];
  }
  if (!isFinite(min) || !isFinite(max) || max < min) {
    return { buckets: [], bucketMs: HOUR_MS, domain: [0, 0] };
  }

  const { start, end, bucketMs, n } = bucketGrid(min, max, range ?? null, chosenBucketMs, utc);
  if (bucketMs < HOUR_MS) return null; // sub-hourly: hourly histograms can't resolve it

  const buckets: TimeBucket[] = Array.from({ length: n }, (_, i) => ({
    t0: start + i * bucketMs,
    counts: {},
    total: 0,
  }));

  for (const [t, counts] of byHour) {
    if (t < start || t >= end) continue;
    const bucket = buckets[Math.floor((t - start) / bucketMs)];
    for (const k in counts) {
      const v = counts[k as RecordKind] ?? 0;
      bucket.counts[k as RecordKind] = (bucket.counts[k as RecordKind] ?? 0) + v;
      bucket.total += v;
    }
  }

  return { buckets, bucketMs, domain: [start, end] };
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

export interface HistBucket {
  /** bucket bounds, ms */
  x0: number;
  x1: number;
  count: number;
}

/**
 * Log-spaced duration histogram — request durations are heavy-tailed, so
 * linear bins put everything in the first bar. Zero/sub-10µs durations are
 * clamped into the lowest bin.
 */
export function logHistogram(durations: number[], bins = 24): HistBucket[] {
  if (durations.length === 0) return [];
  const MIN = 0.01; // 10µs floor
  // a loop, not Math.max(...durations): spreading puts every element on
  // the call stack, which overflows past ~100k instances
  let max = MIN * 10;
  for (const d of durations) if (d > max) max = d;
  const lo = Math.log10(MIN);
  const hi = Math.log10(max * 1.001);
  const step = (hi - lo) / bins;

  const buckets: HistBucket[] = Array.from({ length: bins }, (_, i) => ({
    x0: Math.pow(10, lo + i * step),
    x1: Math.pow(10, lo + (i + 1) * step),
    count: 0,
  }));

  for (const d of durations) {
    const clamped = Math.max(d, MIN);
    let idx = Math.floor((Math.log10(clamped) - lo) / step);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count++;
  }
  return buckets;
}
