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
import { openDb, SIZES_STORE, SEP, bucketRange, cacheDeleteIds } from './cache';
import type { SidecarMeta } from '@redthreadlabs/tracelog-schema';

export interface SizeRecord {
  id: string; // `${bucket}\0${key}`
  channel: string;
  interval: string;
  /** compressed bytes, from the listing — always known */
  compressed: number;
  /** decompressed bytes — FACTUAL from the file's sidecar, else measured on fetch */
  decompressed?: number;
  /** record count, from the sidecar (factual, no fetch needed) */
  records?: number;
  /** hourly interval×kind histogram, from the sidecar (records can be back-dated) */
  intervals?: Record<string, Record<string, number>>;
  /** whether we've already looked for this file's sidecar (don't re-probe 404s) */
  sidecarChecked?: boolean;
  etag?: string;
  /** epoch-ms this file's data was last loaded for a view (LRU recency) */
  displayedAt: number;
  /** whether the file's bytes are currently in the cache (`files` store) */
  cached: boolean;
  /** rolling window of recent distinct S3 LastModified values (epoch-ms) for a
   *  live `_current` file — the durable copy of the poller's in-memory window,
   *  so a fresh load can judge "is this host current?" before observing a tick
   *  (SPEC §6.0; see data/cadence.ts) */
  mtimes?: number[];
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
      records: prev?.records,
      intervals: prev?.intervals,
      sidecarChecked: prev?.sidecarChecked,
      etag: f.etag ?? prev?.etag,
      displayedAt: prev?.displayedAt ?? 0,
      cached: prev?.cached ?? false,
      mtimes: prev?.mtimes,
    });
  }
}

/**
 * Record FACTUAL sidecar data (decompressed bytes, record count, the hourly
 * histogram) for a set of files — no fetch/parse of the log bodies needed.
 * `meta: null` marks the file probed-but-sidecarless so we don't re-check it.
 * Preserves each file's displayedAt/cached. One ledger read, then puts.
 */
export async function recordSidecarsBatch(
  bucket: string,
  entries: {
    key: string;
    channel: string;
    interval: string;
    size: number;
    etag?: string;
    meta: SidecarMeta | null;
  }[],
): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  if (!db) return;
  const prevs = new Map((await ledgerRecords(bucket)).map((r) => [r.id, r]));
  for (const e of entries) {
    const id = bucket + SEP + e.key;
    const prev = prevs.get(id);
    put(db, {
      id,
      channel: e.channel,
      interval: e.interval,
      compressed: e.meta?.compressed || e.size || prev?.compressed || 0,
      decompressed: e.meta ? e.meta.bytes : prev?.decompressed,
      records: e.meta ? e.meta.records : prev?.records,
      intervals: e.meta ? e.meta.intervals : prev?.intervals,
      sidecarChecked: true,
      etag: e.etag ?? prev?.etag,
      displayedAt: prev?.displayedAt ?? 0,
      cached: prev?.cached ?? false,
      mtimes: prev?.mtimes,
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
  const prev = (await ledgerRecords(bucket)).find((r) => r.id === bucket + SEP + file.key);
  put(db, {
    id: bucket + SEP + file.key,
    channel: file.channel,
    interval: file.interval,
    compressed: file.size,
    decompressed,
    records: prev?.records,
    intervals: prev?.intervals,
    sidecarChecked: prev?.sidecarChecked,
    etag: file.etag,
    displayedAt: now,
    cached,
    mtimes: prev?.mtimes,
  });
}

/**
 * Record a live `_current` file's update-cadence window (SPEC §6.0). Targeted
 * single-record read-modify-write (the window is small and this fires per
 * observed flush), create-or-annotate so a host first seen by the live poller
 * still gets a valid ledger record. Other fields are preserved.
 */
export async function recordMtimes(
  bucket: string,
  file: { key: string; channel: string; interval: string; size: number; etag?: string },
  mtimes: number[],
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const id = bucket + SEP + file.key;
  const store = txStore(db, 'readwrite');
  try {
    const req = store.get(id);
    req.onsuccess = () => {
      const prev = req.result as SizeRecord | undefined;
      try {
        store.put({
          id,
          channel: file.channel,
          interval: file.interval,
          compressed: file.size || prev?.compressed || 0,
          decompressed: prev?.decompressed,
          records: prev?.records,
          intervals: prev?.intervals,
          sidecarChecked: prev?.sidecarChecked,
          etag: file.etag ?? prev?.etag,
          displayedAt: prev?.displayedAt ?? 0,
          cached: prev?.cached ?? false,
          mtimes,
        });
      } catch {
        /* storage disabled mid-tx */
      }
    };
  } catch {
    /* storage disabled */
  }
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

/**
 * Estimate the in-memory cost of a planned view, file by file: a known
 * decompressed size from the ledger when we've fetched the file before,
 * else compressed × the channel's measured ratio. Returns the total and the
 * per-file breakdown (aligned to `files`) so the caller can clamp the view.
 */
export async function estimatePlan(
  bucket: string,
  files: { key: string; channel: string; compressed: number }[],
): Promise<{ total: number; perFile: number[] }> {
  const ledger = new Map((await ledgerRecords(bucket)).map((r) => [r.id, r]));
  const ratios = deriveRatios([...ledger.values()]);
  const perFile = files.map((f) =>
    estimateDecompressed(
      [
        {
          channel: f.channel,
          compressed: f.compressed,
          decompressed: ledger.get(bucket + SEP + f.key)?.decompressed,
        },
      ],
      ratios,
    ),
  );
  return { total: perFile.reduce((s, x) => s + x, 0), perFile };
}

/**
 * Choose which files to keep so a view fits a memory budget: the most-recent
 * files (later interval first) up to the limit, always keeping at least the
 * single most-recent so the action loads *something*. Returns the kept
 * indices into `files`, in original order. Pure — unit-testable.
 */
export function clampByMemory(
  files: { interval: string }[],
  perFile: number[],
  limitBytes: number,
): number[] {
  const order = files
    .map((f, i) => ({ i, interval: f.interval }))
    .sort((a, b) => b.interval.localeCompare(a.interval));
  const keep: number[] = [];
  let total = 0;
  for (const { i } of order) {
    const est = perFile[i] ?? 0;
    if (keep.length > 0 && total + est > limitBytes) break;
    keep.push(i);
    total += est;
  }
  return keep.sort((a, b) => a - b);
}

/**
 * Eviction order for cached files (pure): least-recently-*displayed* first;
 * ties broken by older interval first, then bigger file first. The front of
 * this list is dropped first when the cache is over budget.
 */
export function evictionOrder(cached: SizeRecord[]): SizeRecord[] {
  return [...cached].sort(
    (a, b) =>
      a.displayedAt - b.displayedAt || // least recently displayed
      a.interval.localeCompare(b.interval) || // then older interval
      (b.decompressed ?? 0) - (a.decompressed ?? 0), // then bigger
  );
}

/** Bytes a cached file occupies on disk — IndexedDB holds the gzip form, so
 *  this is the compressed (listing) size, which is exact. */
function cachedBytes(r: SizeRecord): number {
  return r.compressed;
}

/**
 * Enforce the cache byte budget: while the cached total exceeds limitBytes,
 * drop the eviction-order front — deleting bytes from the `files` store but
 * keeping the size record (cached=false), so we still know its size.
 */
export async function enforceCacheLimit(bucket: string, limitBytes: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const records = await ledgerRecords(bucket);
  const cached = records.filter((r) => r.cached);
  let total = cached.reduce((s, r) => s + cachedBytes(r), 0);
  if (total <= limitBytes) return;

  const evict: SizeRecord[] = [];
  for (const r of evictionOrder(cached)) {
    if (total <= limitBytes) break;
    evict.push(r);
    total -= cachedBytes(r);
  }
  await cacheDeleteIds(evict.map((r) => r.id));
  for (const r of evict) put(db, { ...r, cached: false });
}
