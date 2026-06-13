/**
 * The size ledger (SPEC §8): a persistent, per-file record of sizes that
 * OUTLIVES the byte cache. When LRU eviction drops a file's bytes we keep
 * its size record, so we can still reason about the cost of re-fetching it,
 * and — crucially — estimate the decompressed (in-memory) size of files we
 * have *not* fetched yet, from the compression ratio of other files we've
 * seen in the same channel. That estimate is what lets the memory-limit
 * check be honest before a single byte is downloaded.
 *
 * Lives in the same IndexedDB as the cache, in its own `sizes` store, so a
 * cache-byte eviction never touches it; a full workspace purge clears both.
 */
import { openDb, SIZES_STORE, SEP, bucketRange } from './cache';

export interface SizeRecord {
  id: string; // `${bucket}\0${key}`
  channel: string;
  interval: string;
  /** compressed bytes, from the listing — always known */
  compressed: number;
  /** decompressed bytes, once the file has actually been fetched */
  decompressed?: number;
  etag?: string;
  /** epoch-ms this file's data was last loaded for a view (LRU recency) */
  displayedAt: number;
  /** whether the file's bytes are currently in the cache (`files` store) */
  cached: boolean;
}

/** Per-channel decompressed/compressed ratio, for estimating unseen files. */
export interface Ratios {
  byChannel: Map<string, number>;
  overall: number; // fallback when a channel has no measured ratio yet
}

const DEFAULT_RATIO = 10; // gzipped JSONL inflates ~10x; used until measured

/**
 * Estimate the decompressed (in-memory) bytes a set of files would occupy:
 * the measured decompressed size when known, else compressed × the channel's
 * ratio (or the overall/default ratio). Pure — unit-testable without IndexedDB.
 */
export function estimateDecompressed(
  files: { channel: string; compressed: number; decompressed?: number }[],
  ratios: Ratios,
): number {
  let total = 0;
  for (const f of files) {
    if (f.decompressed != null) total += f.decompressed;
    else total += f.compressed * (ratios.byChannel.get(f.channel) ?? ratios.overall);
  }
  return total;
}

/** Derive per-channel and overall ratios from records with both sizes. */
export function deriveRatios(records: SizeRecord[]): Ratios {
  const sum = new Map<string, { c: number; d: number }>();
  let allC = 0;
  let allD = 0;
  for (const r of records) {
    if (r.decompressed == null || r.compressed <= 0) continue;
    const agg = sum.get(r.channel) ?? { c: 0, d: 0 };
    agg.c += r.compressed;
    agg.d += r.decompressed;
    sum.set(r.channel, agg);
    allC += r.compressed;
    allD += r.decompressed;
  }
  const byChannel = new Map<string, number>();
  for (const [ch, { c, d }] of sum) if (c > 0) byChannel.set(ch, d / c);
  return { byChannel, overall: allC > 0 ? allD / allC : DEFAULT_RATIO };
}

// ----------------------------------------------------------- IndexedDB I/O

function txStore(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(SIZES_STORE, mode).objectStore(SIZES_STORE);
}

/** All ledger records for a bucket (small — metadata only, no bytes). */
export async function ledgerRecords(bucket: string): Promise<SizeRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = txStore(db, 'readonly').getAll(bucketRange(bucket));
      req.onsuccess = () => resolve((req.result as SizeRecord[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function put(db: IDBDatabase, rec: SizeRecord): void {
  try {
    txStore(db, 'readwrite').put(rec);
  } catch {
    /* storage disabled */
  }
}

/**
 * Record compressed sizes seen in a listing (files may never be fetched).
 * Upserts without clobbering a known decompressed size or displayedAt.
 */
export async function recordListing(
  bucket: string,
  files: { key: string; channel: string; interval: string; size: number; etag?: string }[],
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const existing = new Map((await ledgerRecords(bucket)).map((r) => [r.id, r]));
  for (const f of files) {
    const id = bucket + SEP + f.key;
    const prev = existing.get(id);
    put(db, {
      id,
      channel: f.channel,
      interval: f.interval,
      compressed: f.size || prev?.compressed || 0,
      decompressed: prev?.decompressed,
      etag: f.etag ?? prev?.etag,
      displayedAt: prev?.displayedAt ?? 0,
      cached: prev?.cached ?? false,
    });
  }
}

/** Record a fetched file: decompressed size known, freshly displayed. */
export async function recordFetched(
  bucket: string,
  file: { key: string; channel: string; interval: string; size: number; etag?: string },
  decompressed: number,
  cached: boolean,
  now: number,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  put(db, {
    id: bucket + SEP + file.key,
    channel: file.channel,
    interval: file.interval,
    compressed: file.size,
    decompressed,
    etag: file.etag,
    displayedAt: now,
    cached,
  });
}

/** Bump display recency for files just loaded to satisfy a view. */
export async function markDisplayed(bucket: string, keys: string[], now: number): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  if (!db) return;
  const recs = new Map((await ledgerRecords(bucket)).map((r) => [r.id, r]));
  for (const key of keys) {
    const rec = recs.get(bucket + SEP + key);
    if (rec) put(db, { ...rec, displayedAt: now });
  }
}

/** The ratios for a bucket, ready for estimateDecompressed. */
export async function bucketRatios(bucket: string): Promise<Ratios> {
  return deriveRatios(await ledgerRecords(bucket));
}
