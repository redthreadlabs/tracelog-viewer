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
// v2: record keys gained the bucket namespace; old un-namespaced entries are
// dropped wholesale on upgrade (a one-time cold cache, nothing else lost).
const DB_VERSION = 2;

/** `bucket + \0 + key` — \0 can appear in neither, so the join is unambiguous. */
const SEP = '\u0000';

interface CachedFile {
  id: string; // `${bucket}\0${key}`
  etag: string;
  bytes: Uint8Array;
}

/** Range covering every record of one bucket (\u0001 is the next code unit). */
function bucketRange(bucket: string): IDBKeyRange {
  return IDBKeyRange.bound(bucket + SEP, bucket + '\u0001', false, true);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: 'id' });
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
