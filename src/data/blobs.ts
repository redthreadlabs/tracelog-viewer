/**
 * The blob layer (SPEC §8): two tiers of file-byte caching sit between the
 * scanner and S3.
 *
 *  1. IndexedDB (data/cache.ts) holds files in their COMPRESSED form — the
 *     exact gzip bytes S3 stores, fetched raw via a Range request so the
 *     browser never inflates them (see LogBucket.getObjectCompressed). That
 *     makes the on-disk cache ~10x smaller, so the cache limit covers far
 *     more history, and its accounting matches the listing size exactly.
 *  2. An in-memory LRU (MemBytes) holds recently-touched files DECOMPRESSED,
 *     bounded by the workspace memory limit, so parsing and raw-line
 *     re-reads don't pay the inflate cost twice for a hot file.
 *
 * Reads come off the hot tier first, then inflate from IndexedDB, then miss
 * (the caller goes to the network). A fallback path re-compresses if we ever
 * receive already-inflated bytes, so the disk tier stays compressed
 * regardless of what the fetch layer hands back.
 */
import { cacheGet, cacheGetAny, cachePut } from './cache';
import { gzip, gunzip, isGzip } from './gzip';

/**
 * A byte-budgeted, insertion-ordered LRU of decompressed file bodies. `get`
 * bumps recency; `put` evicts the oldest entries once over budget, but always
 * keeps the most-recently-inserted (so a single file larger than the whole
 * budget is still usable). A null budget means no limit.
 */
export class MemBytes {
  private map = new Map<string, Uint8Array>();
  private total = 0;

  constructor(public readonly limitBytes: number | null) {}

  get bytes(): number {
    return this.total;
  }

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key); // re-insert at the back → most recently used
      this.map.set(key, v);
    }
    return v;
  }

  put(key: string, bytes: Uint8Array): void {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.total -= prev.length;
      this.map.delete(key);
    }
    this.map.set(key, bytes);
    this.total += bytes.length;
    this.evict();
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.total -= v.length;
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  private evict(): void {
    if (this.limitBytes == null) return;
    for (const [k, v] of this.map) {
      if (this.total <= this.limitBytes || this.map.size <= 1) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
}

/** Decompressed bytes for a finalized file: hot LRU → IndexedDB (inflate). */
export async function cachedDecompressed(
  mem: MemBytes,
  bucket: string,
  key: string,
  etag: string | undefined,
): Promise<Uint8Array | null> {
  const hot = mem.get(key);
  if (hot) return hot;
  const stored = await cacheGet(bucket, key, etag);
  if (!stored) return null;
  const raw = isGzip(stored) ? await gunzip(stored) : stored;
  mem.put(key, raw);
  return raw;
}

/** Like cachedDecompressed but ETag-agnostic (the drawer's raw-line peek). */
export async function cachedDecompressedAny(
  mem: MemBytes,
  bucket: string,
  key: string,
): Promise<Uint8Array | null> {
  const hot = mem.get(key);
  if (hot) return hot;
  const stored = await cacheGetAny(bucket, key);
  if (!stored) return null;
  const raw = isGzip(stored) ? await gunzip(stored) : stored;
  mem.put(key, raw);
  return raw;
}

/**
 * Take a freshly-fetched file (ideally raw gzip from getObjectCompressed),
 * stash the COMPRESSED form in IndexedDB and the DECOMPRESSED form hot in
 * memory, and return the decompressed bytes for parsing. If the fetch layer
 * already inflated it (no gzip magic), we re-compress for the disk tier so it
 * stays small. The disk write is awaited so the size ledger's `cached` flag
 * is accurate when post-scan eviction reads it.
 */
export async function storeFetched(
  mem: MemBytes,
  bucket: string,
  key: string,
  etag: string | undefined,
  fetched: Uint8Array,
): Promise<Uint8Array> {
  const gz = isGzip(fetched);
  const raw = gz ? await gunzip(fetched) : fetched;
  mem.put(key, raw);
  if (etag) {
    const compressed = gz ? fetched : await gzip(fetched);
    try {
      await cachePut(bucket, key, etag, compressed);
    } catch {
      /* storage or codec unavailable — degrade to network on the next read */
    }
  }
  return raw;
}
