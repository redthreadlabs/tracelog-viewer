/**
 * The transaction index (SPEC §11): the first concrete pluggable aggregate
 * index. Per file it rolls up transaction COUNT + Σ duration, grouped by
 * transaction name within each UTC hour. Built once at parse time and persisted
 * in its own IndexedDB store, so it OUTLIVES the byte cache — a later query for
 * COUNT / SUM(duration) GROUP BY transaction at ≥1h granularity can be served by
 * merging these rollups, without re-fetching or re-scanning the records.
 *
 * Hourly UTC granularity matches the sidecar convention and the ≥1h queries it
 * can satisfy; finer buckets fall back to the record scan. An index is always an
 * optimization, never a correctness requirement (drop it → same answers, slower).
 */
import type { Rec } from './types';
import { hourBucket } from '@redthreadlabs/tracelog-schema';
import { openDb, INDEX_STORE, SEP, bucketRange } from './cache';

export interface TxnHourEntry {
  /** transaction count */
  c: number;
  /** Σ duration, ms */
  d: number;
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
    const byName = (index[hourBucket(r.ts)] ??= {});
    const entry = (byName[r.name] ??= { c: 0, d: 0 });
    entry.c += 1;
    entry.d += r.duration ?? 0;
  }
  return index;
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
