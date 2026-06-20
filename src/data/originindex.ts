/**
 * Origin index — the first POINT-LOOKUP index (find an *individual* record),
 * unlike the aggregate indexes (txnindex / durhist) that answer time-series
 * queries. It resolves a client record's RecordOrigin across the time window:
 * the SDK emits a lifetime's origin once (at launch), so a window that excludes
 * that interval has records with a `lifetime_id` but no origin in view. This
 * index closes that gap by pointing at where the origin physically is.
 *
 * ── The seam (concrete now; general implied) ──────────────────────────────
 * Everything above the `resolveOrigin` divider is a concrete specialization of
 * a latent general primitive — a **keyed locator index**: per file, a map from
 * a KEY to the LINE NUMBERS of the records bearing it. The two choices a general
 * version would take as parameters are isolated and labelled below:
 *     SELECTOR  kind === 'metadata'      (which records to index)
 *     KEY       body.lifetime_id         (what to key them by)
 * and the reads are `has(key)` (containment — "does this file have it?") and
 * `linesFor(key)` (the locators). Containment is just the degenerate read of the
 * locator map. When a SECOND point-lookup appears, lift SELECTOR + KEY into
 * params and move the payload type + build + I/O + has/linesFor into a shared
 * `containment.ts`; this file keeps only what does NOT generalize — the backward
 * interval hop and reading/parsing the located line into a RecordOrigin.
 */
import type { RecordOrigin } from '@redthreadlabs/tracelog-schema';
import type { ParsedKey } from '../s3/keys';
import { openDb, ORIGIN_STORE, SEP, bucketRange } from './cache';

// ── general (latent): keyed locator index ──────────────────────────────────

/** Per file: key → the line numbers of matching records. (`[]` tolerates
 *  multiple matches; an origin lifetime has one line per file, taken as [0].) */
export type LocatorFileIndex = Record<string, number[]>;

/** A line tagged with the key it should be indexed under — what the parser
 *  emits for each SELECTOR-matching record. */
export interface KeyedLine {
  key: string;
  line: number;
}

/** Roll a file's keyed lines into the locator map. Pure (no SELECTOR/KEY here —
 *  the parser already applied them; that application is the part that
 *  generalizes into (selector, key) params). */
export function buildLocatorIndex(entries: KeyedLine[]): LocatorFileIndex {
  const index: LocatorFileIndex = {};
  for (const { key, line } of entries) (index[key] ??= []).push(line);
  return index;
}

/** Containment — the degenerate read: does this file hold the key at all? */
export function has(index: LocatorFileIndex, key: string): boolean {
  return index[key] !== undefined;
}

/** The locators: the line numbers of the key's matching records ([] if none). */
export function linesFor(index: LocatorFileIndex, key: string): number[] {
  return index[key] ?? [];
}

// ── general (latent): IndexedDB I/O (txnindex twins, own store) ─────────────

interface LocatorIndexRecord {
  id: string; // `${bucket}\0${key}`
  etag?: string;
  index: LocatorFileIndex;
}

/** Persist a file's locator index, keyed by bucket+key with its ETag. Best-effort. */
export async function putOriginIndex(
  bucket: string,
  key: string,
  etag: string | undefined,
  index: LocatorFileIndex,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(ORIGIN_STORE, 'readwrite');
      tx.objectStore(ORIGIN_STORE).put({ id: bucket + SEP + key, etag, index } satisfies LocatorIndexRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Every stored origin index for a bucket, by file id (`${bucket}\0${key}`). */
export async function originIndexRecords(
  bucket: string,
): Promise<Map<string, { etag?: string; index: LocatorFileIndex }>> {
  const db = await openDb();
  if (!db) return new Map();
  return new Promise((resolve) => {
    try {
      const req = db
        .transaction(ORIGIN_STORE, 'readonly')
        .objectStore(ORIGIN_STORE)
        .getAll(bucketRange(bucket));
      req.onsuccess = () => {
        const out = new Map<string, { etag?: string; index: LocatorFileIndex }>();
        for (const r of (req.result as LocatorIndexRecord[]) ?? []) {
          out.set(r.id, { etag: r.etag, index: r.index });
        }
        resolve(out);
      };
      req.onerror = () => resolve(new Map());
    } catch {
      resolve(new Map());
    }
  });
}

// ── bespoke (does NOT generalize): the backward interval hop + body read ────

export interface OriginResolverDeps {
  /** Load a file's persisted locator index (IndexedDB), or null if not indexed. */
  loadIndex: (file: ParsedKey) => Promise<LocatorFileIndex | null>;
  /** Read line `line` of a file and parse its `{ metadata: RecordOrigin }` body. */
  readOriginLine: (file: ParsedKey, line: number) => Promise<RecordOrigin | null>;
}

/**
 * Resolve `lifetimeId`'s RecordOrigin by walking the channel's files backward
 * from the record's own interval. Intervals are lexicographically ordered
 * (`YYYY-MM-DD[THH]`), so "earlier" is a string compare; each interval probes
 * all of its files (every host/seq — a load-balanced fleet can split a lifetime
 * across hosts). `maxHops` bounds how many PRIOR intervals to walk (0 = the
 * record's interval only); a launch's origin is temporally near its records, so
 * a few hops find it. A miss is an expected, non-exceptional outcome → null.
 */
export async function resolveOrigin(
  lifetimeId: string,
  fromInterval: string,
  channelFiles: ParsedKey[],
  maxHops: number,
  deps: OriginResolverDeps,
): Promise<RecordOrigin | null> {
  // distinct intervals at or before the record's, newest→older, capped at maxHops+1
  const intervals = [...new Set(channelFiles.map((f) => f.interval))]
    .filter((iv) => iv <= fromInterval)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, maxHops + 1);

  for (const interval of intervals) {
    for (const file of channelFiles) {
      if (file.interval !== interval) continue;
      const index = await deps.loadIndex(file);
      if (!index) continue;
      const lines = linesFor(index, lifetimeId);
      if (lines.length === 0) continue;
      const origin = await deps.readOriginLine(file, lines[0]);
      if (origin) return origin;
    }
  }
  return null;
}
