/**
 * IndexedDB cache of finalized files (SPEC §5, §8): keyed by S3 key, with
 * ETag as the immutability check — a finalized tracelog file never changes,
 * so a hit is cached forever. `_current` snapshots are never cached. Every
 * failure path degrades silently to the network.
 */

const DB_NAME = 'tracelog-viewer';
const STORE = 'files';

interface CachedFile {
  key: string;
  etag: string;
  bytes: Uint8Array;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'key' });
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

export async function cacheGet(key: string, etag: string | undefined): Promise<Uint8Array | null> {
  if (!etag) return null;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
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

export async function cachePut(key: string, etag: string | undefined, bytes: Uint8Array): Promise<void> {
  if (!etag) return;
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, etag, bytes } satisfies CachedFile);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Keys of all cached files — keys only, no byte payloads materialized. */
export async function cacheKeys(): Promise<Set<string>> {
  const db = await openDb();
  if (!db) return new Set();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAllKeys();
      request.onsuccess = () => resolve(new Set(request.result as string[]));
      request.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}
