/**
 * IndexedDB cache of finalized files (SPEC §5, §8): namespaced by bucket and
 * keyed by S3 key, with ETag as the immutability check — a finalized tracelog
 * file never changes, so a hit is cached forever. Namespacing matters because
 * tracelog's layout makes the same key (`server/<day>/<host>.jsonl.gz`) exist
 * in *every* tracelog bucket; without it, switching profiles thrashes the
 * colliding entries and "cached" indicators lie. `_current` snapshots are
 * never cached. Every failure path degrades silently to the network.
 */

const DB_NAME = 'tracelog-viewer';
const STORE = 'files';
/** the size ledger (data/ledger.ts) — per-file metadata that outlives bytes */
export const SIZES_STORE = 'sizes';
/** per-file aggregate indexes (data/txnindex.ts) — parse-time rollups that
 *  outlive bytes, so a query can be satisfied without re-fetching (SPEC §11) */
export const INDEX_STORE = 'txnindex';
/** per-file duration histograms (data/durhist.ts) — the holistic P95 sketch,
 *  kept separate so the chart's hot path doesn't load it */
export const DURHIST_STORE = 'durhist';
// v2: record keys gained the bucket namespace. v3: added the `sizes` ledger,
// which survives byte eviction (so we still know file sizes after a purge).
// v4: `files` now holds gzip-COMPRESSED bytes (was decompressed), so the old
// entries are dropped once and re-fetched in compressed form.
// v5: added the `txnindex` store (per-file transaction rollup index).
// v6: txnindex cells gained an error counter ({c,d}→{c,d,e}); drop the stale
//     payloads once so they rebuild on next load.
// v7: added the `durhist` store (per-file duration histograms for P95).
const DB_VERSION = 7;

/** `bucket + \0 + key` — \0 can appear in neither, so the join is unambiguous. */
export const SEP = '\u0000';

interface CachedFile {
  id: string; // `${bucket}\0${key}`
  etag: string;
  bytes: Uint8Array;
}

/** Range covering every record of one bucket (\u0001 is the next code unit). */
export function bucketRange(bucket: string): IDBKeyRange {
  return IDBKeyRange.bound(bucket + SEP, bucket + '\u0001', false, true);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (ev) => {
        const db = request.result;
        // v1 used an un-namespaced files store; pre-v4 held decompressed
        // bytes. Either way the old `files` entries are unusable now, so drop
        // and recreate the store once (the `sizes` ledger is left intact).
        if (ev.oldVersion < 4 && db.objectStoreNames.contains(STORE)) {
          db.deleteObjectStore(STORE);
        }
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SIZES_STORE)) {
          db.createObjectStore(SIZES_STORE, { keyPath: 'id' });
        }
        // v6 changed the txnindex payload shape — drop stale entries so they
        // rebuild (parse-time) with the new error counter
        if (ev.oldVersion < 6 && db.objectStoreNames.contains(INDEX_STORE)) {
          db.deleteObjectStore(INDEX_STORE);
        }
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          db.createObjectStore(INDEX_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(DURHIST_STORE)) {
          db.createObjectStore(DURHIST_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null); // e.g. storage disabled
    }
  });
  return dbPromise;
}

export async function cacheGet(
  bucket: string,
  key: string,
  etag: string | undefined,
): Promise<Uint8Array | null> {
  if (!etag) return null;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(bucket + SEP + key);
      request.onsuccess = () => {
        const hit = request.result as CachedFile | undefined;
        resolve(hit && hit.etag === etag ? hit.bytes : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(
  bucket: string,
  key: string,
  etag: string | undefined,
  bytes: Uint8Array,
): Promise<void> {
  if (!etag) return;
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id: bucket + SEP + key, etag, bytes } satisfies CachedFile);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * One cached file's bytes regardless of ETag (on-demand raw re-reads: the
 * store's records and the cache entry came from the same fetch, so for
 * this purpose whatever is cached under the key IS the right content).
 */
export async function cacheGetAny(bucket: string, key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(bucket + SEP + key);
      request.onsuccess = () => {
        const hit = request.result as CachedFile | undefined;
        resolve(hit ? hit.bytes : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** S3 keys of one bucket's cached files — keys only, no byte payloads. */
export async function cacheKeys(bucket: string): Promise<Set<string>> {
  const db = await openDb();
  if (!db) return new Set();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAllKeys(bucketRange(bucket));
      request.onsuccess = () =>
        resolve(new Set((request.result as string[]).map((id) => id.slice(bucket.length + 1))));
      request.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}

/** Delete specific cached byte entries by ledger id (`bucket\0key`) — used
 * by LRU eviction; the size ledger keeps the records. */
export async function cacheDeleteIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      for (const id of ids) store.delete(id);
      const tx = store.transaction;
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Drop every cached file of one bucket (profile deletion). */
export async function cacheWipeBucket(bucket: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(bucketRange(bucket));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Full purge: drop everything this origin stores — bytes AND the per-file
 *  metadata that outlives them (the size ledger and the aggregate indexes). */
export async function cacheWipeAll(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readwrite');
      for (const name of names) tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
