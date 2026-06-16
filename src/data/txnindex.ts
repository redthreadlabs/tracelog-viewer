/**
 * The transaction index (SPEC §11): the first concrete pluggable aggregate
 * index. Per file it rolls up transaction COUNT + Σ duration, grouped by
 * transaction name within each UTC hour. Built once at parse time and persisted
 * in its own IndexedDB store, so it OUTLIVES the byte cache — a later query for
 * COUNT / SUM(duration) GROUP BY transaction at ≥1h granularity can be served by
 * merging these rollups, without re-fetching or re-scanning the records.
 *
 * Hourly UTC granularity matches the sidecar convention and the ≥1h queries it
 * can satisfy; finer periods fall back to the record scan. An index is always an
 * optimization, never a correctness requirement (drop it → same answers, slower).
 */
import type { Rec } from './types';
import { type WeightedPoint, resultFamily } from './aggregate';
import { hourInterval } from '@redthreadlabs/tracelog-schema';
import { openDb, INDEX_STORE, SEP, bucketRange } from './cache';

export const HOUR_MS = 3_600_000;

/** Parse a UTC hour label 'YYYY-MM-DDTHH' back to epoch-ms, or null. */
export function hourLabelToMs(label: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(label);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

export interface TxnHourEntry {
  /** transaction count */
  c: number;
  /** Σ duration, ms */
  d: number;
  /** count whose result family is 'bad' (5xx / error / failure) */
  e: number;
}

/** UTC hour label 'YYYY-MM-DDTHH' → transaction name → entry */
export type TxnFileIndex = Record<string, Record<string, TxnHourEntry>>;

export interface TxnIndexRecord {
  id: string; // `${bucket}\0${key}`
  etag?: string;
  index: TxnFileIndex;
}

/**
 * Build a file's transaction index from its parsed records (transactions only;
 * a record with a missing/garbage timestamp is skipped, matching the sidecar's
 * "malformed" handling). Pure — unit-testable without IndexedDB.
 */
export function buildTxnIndex(records: Rec[]): TxnFileIndex {
  const index: TxnFileIndex = {};
  for (const r of records) {
    if (r.kind !== 'transaction' || r.ts <= 0) continue;
    const byName = (index[hourInterval(r.ts)] ??= {});
    const entry = (byName[r.name] ??= { c: 0, d: 0, e: 0 });
    entry.c += 1;
    entry.d += r.duration ?? 0;
    if (resultFamily(r) === 'bad') entry.e += 1;
  }
  return index;
}

/**
 * Turn a file's index into pre-aggregated points for the series aggregator.
 * `weight` is the transaction count (op='count') or Σ duration (op='sum').
 * Only hours that fall fully inside [from, to) are emitted — an hourly entry
 * can't be split at a range edge.
 *
 * Two projections, both exact:
 *  - native (`fixedKey` omitted): one point per transaction name (filtered by
 *    `show` = transaction names).
 *  - file-level (`fixedKey` set, e.g. the file's host): every name in the file
 *    collapses into ONE group keyed by `fixedKey` — valid because the file is
 *    homogeneous in that attribute. `show` then filters on `fixedKey`.
 */
export function txnIndexPoints(
  index: TxnFileIndex,
  op: 'count' | 'sum',
  field: string | undefined,
  from: number,
  to: number,
  show?: Set<string>,
  fixedKey?: string,
): WeightedPoint[] {
  // count → c; sum(duration) → d; sum(errors) → e
  const weigh = (entry: TxnHourEntry): number =>
    op === 'count' ? entry.c : field === 'errors' ? entry.e : entry.d;
  const points: WeightedPoint[] = [];
  for (const label in index) {
    const t = hourLabelToMs(label);
    if (t === null || t < from || t + HOUR_MS > to) continue; // hour fully in range
    const byName = index[label];
    if (fixedKey !== undefined) {
      if (show && !show.has(fixedKey)) continue; // whole file is one group
      let weight = 0;
      for (const name in byName) weight += weigh(byName[name]);
      if (weight !== 0) points.push({ name: fixedKey, t, weight });
    } else {
      for (const name in byName) {
        if (show && !show.has(name)) continue;
        const weight = weigh(byName[name]);
        if (weight !== 0) points.push({ name, t, weight });
      }
    }
  }
  return points;
}

/** Summed transaction totals for a name over a range (count, Σ duration, errors). */
export type TxnTotals = { c: number; d: number; e: number };

/**
 * Merge one file's hourly cells — for hours fully inside [from, to) — into a
 * per-transaction totals accumulator. The whole-range counterpart of
 * `txnIndexPoints`: where that emits per-period points for a series chart, this
 * collapses to one totals row per name for the transaction table. Distributive,
 * so summing across files is exact. (`count` here also serves as the up-front
 * cost estimate for whether an exact P95 scan is affordable — SPEC §11.5.)
 */
export function mergeRangeTotals(
  index: TxnFileIndex,
  from: number,
  to: number,
  into: Map<string, TxnTotals>,
): void {
  for (const label in index) {
    const t = hourLabelToMs(label);
    if (t === null || t < from || t + HOUR_MS > to) continue; // hour fully in range
    const byName = index[label];
    for (const name in byName) {
      const src = byName[name];
      let dst = into.get(name);
      if (!dst) into.set(name, (dst = { c: 0, d: 0, e: 0 }));
      dst.c += src.c;
      dst.d += src.d;
      dst.e += src.e;
    }
  }
}

// --------------------------------------------------------------- IndexedDB I/O

/**
 * Persist a file's transaction index, keyed by bucket+key with its ETag for
 * validity (the matcher re-checks the ETag before trusting it). Best-effort —
 * storage disabled degrades silently to the scan path.
 */
export async function putTxnIndex(
  bucket: string,
  key: string,
  etag: string | undefined,
  index: TxnFileIndex,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(INDEX_STORE, 'readwrite');
      tx.objectStore(INDEX_STORE).put({
        id: bucket + SEP + key,
        etag,
        index,
      } satisfies TxnIndexRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Every stored transaction index for a bucket (the matcher validates each
 *  against its file's current ETag before using it). */
export async function txnIndexRecords(bucket: string): Promise<TxnIndexRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db
        .transaction(INDEX_STORE, 'readonly')
        .objectStore(INDEX_STORE)
        .getAll(bucketRange(bucket));
      req.onsuccess = () => resolve((req.result as TxnIndexRecord[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
