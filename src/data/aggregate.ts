/**
 * Pure aggregation helpers for the overview: time-bucketed volume and
 * per-transaction-name rollups. No DOM, no D3 — unit-testable.
 */
import type { Rec, RecordKind } from './types';

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
const BUCKET_STEPS_MS = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  3 * 3_600_000,
  6 * 3_600_000,
  24 * 3_600_000, // 1d
];

const TARGET_MAX_BUCKETS = 120;

export function chooseBucketMs(spanMs: number): number {
  for (const step of BUCKET_STEPS_MS) {
    if (spanMs / step <= TARGET_MAX_BUCKETS) return step;
  }
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

export function bucketByTime(records: Rec[], window?: [number, number] | null): BucketResult {
  let min = Infinity;
  let max = -Infinity;
  for (const r of records) {
    if (r.ts <= 0) continue;
    if (r.ts < min) min = r.ts;
    if (r.ts > max) max = r.ts;
  }
  if (window) {
    min = window[0];
    max = window[1];
  }
  if (!isFinite(min) || !isFinite(max) || max < min) {
    return { buckets: [], bucketMs: 60_000, domain: [0, 0] };
  }

  const bucketMs = chooseBucketMs(Math.max(max - min, 1));
  const start = Math.floor(min / bucketMs) * bucketMs;
  const end = Math.floor(max / bucketMs) * bucketMs + bucketMs;
  const n = Math.round((end - start) / bucketMs);

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

export interface TxnGroup {
  name: string;
  count: number;
  /** ms */
  totalDuration: number;
}

export type TxnSortKey = 'name' | 'count' | 'totalDuration';

export function groupTransactions(
  records: Rec[],
  window?: [number, number] | null,
): TxnGroup[] {
  const groups = new Map<string, TxnGroup>();
  for (const r of records) {
    if (r.kind !== 'transaction') continue;
    if (window && (r.ts < window[0] || r.ts > window[1])) continue;
    let group = groups.get(r.name);
    if (!group) {
      group = { name: r.name, count: 0, totalDuration: 0 };
      groups.set(r.name, group);
    }
    group.count++;
    group.totalDuration += r.duration ?? 0;
  }
  return [...groups.values()];
}

export function sortTxnGroups(groups: TxnGroup[], key: TxnSortKey, desc: boolean): TxnGroup[] {
  const sorted = [...groups].sort((a, b) =>
    key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key],
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
  window?: [number, number] | null,
): TxnStats {
  const instances = records
    .filter(
      (r) =>
        r.kind === 'transaction' &&
        r.name === name &&
        (!window || (r.ts >= window[0] && r.ts <= window[1])),
    )
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
  const max = Math.max(...durations, MIN * 10);
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
