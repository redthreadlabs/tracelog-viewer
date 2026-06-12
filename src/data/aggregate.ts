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
