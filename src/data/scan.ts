/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import type { ScanPlan } from '../s3/scanner';
import { type ParsedKey, overlapsRange } from '../s3/keys';
import { parseFile } from './parse';
import { cachedDecompressed, storeFetched, type MemBytes } from './blobs';
import { recordFetched, enforceCacheLimit, recordSidecarsBatch, ledgerRecords } from './ledger';
import { SEP } from './cache';
import type { Store } from './store';
import { perf } from './perf';

const CONCURRENCY = 4;
const SIDECAR_CONCURRENCY = 8;

/**
 * Populate the size ledger with FACTUAL data from finalized files' sidecars
 * (decompressed bytes, record count, hourly histogram), so the memory-limit
 * estimate is exact rather than ratio-based. Only probes files not already
 * checked (sidecarChecked); a 404 marks the file sidecarless so it is never
 * re-probed. Best-effort — a failure just leaves the file to be estimated.
 */
export async function hydrateSidecars(bucket: LogBucket, files: ParsedKey[]): Promise<void> {
  const have = new Map((await ledgerRecords(bucket.bucket)).map((r) => [r.id, r]));
  const need = files.filter(
    (f) => !f.current && !have.get(bucket.bucket + SEP + f.key)?.sidecarChecked,
  );
  if (need.length === 0) return;

  const entries: Parameters<typeof recordSidecarsBatch>[1] = [];
  const queue = [...need];
  async function worker(): Promise<void> {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const meta = await bucket.getSidecar(f.key);
      entries.push({
        key: f.key,
        channel: f.channel,
        interval: f.interval,
        size: f.size,
        etag: f.etag,
        meta,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SIDECAR_CONCURRENCY, need.length) }, () => worker()),
  );
  await recordSidecarsBatch(bucket.bucket, entries);
}

/** Fetch one file's bytes (hot LRU / IndexedDB first), parse it, and time both. */
async function fetchAndParse(
  bucket: LogBucket,
  file: ParsedKey,
  mem: MemBytes,
): Promise<{ result: ReturnType<typeof parseFile>; fromCache: boolean }> {
  const doneFetch = perf.begin('fetch', file.key);
  // finalized files: hot decompressed LRU → IndexedDB (compressed) inflated
  let bytes = file.current ? null : await cachedDecompressed(mem, bucket.bucket, file.key, file.etag);
  const fromCache = bytes !== null;
  if (!bytes) {
    if (file.current) {
      bytes = await bucket.getObjectBytes(file.key); // volatile snapshot, never cached
    } else {
      // pull the stored gzip bytes raw, cache them as-is, inflate for parsing
      bytes = await storeFetched(
        mem,
        bucket.bucket,
        file.key,
        file.etag,
        await bucket.getObjectCompressed(file.key),
      );
    }
  }
  doneFetch({ bytes: bytes.length, cached: fromCache });

  const doneParse = perf.begin('parse', file.key);
  // Finalized files are cached, so their records shed raw lines (rawsource
  // re-reads on demand); _current snapshots have no cache to go back to.
  const result = parseFile(bytes, file, {}, !file.current);
  doneParse({ bytes: result.byteLength, records: result.records.length });
  // ledger: now we know this file's decompressed size, and it was just
  // loaded for display (feeds the per-channel ratio + LRU recency); awaited
  // so the ledger is settled before post-scan cache eviction reads it
  await recordFetched(bucket.bucket, file, result.byteLength, !file.current, Date.now());
  return { result, fromCache };
}

export async function executeScan(
  store: Store,
  bucket: LogBucket,
  plan: ScanPlan,
  cacheLimitBytes: number | null,
  mem: MemBytes,
  getWindow: () => [number, number] | null = () => null,
): Promise<void> {
  store.clear();
  // a fresh view supersedes the old working set; the memory budget governs
  // the decompressed bytes of *this* view, so drop the prior hot bytes
  mem.clear();
  store.setProgress({
    filesTotal: plan.files.length,
    filesDone: 0,
    bytesDone: 0,
    filesFromCache: 0,
    running: true,
    error: undefined,
  });

  const doneScan = perf.begin('scan', `scan s3://${bucket.bucket}`);
  // a sparse queue (entries nulled as taken) so we can pick by priority each
  // iteration; the plan is newest-first, so the first match is the newest one
  const queue: (ParsedKey | null)[] = [...plan.files];
  let failed: string | undefined;
  let parsedBytes = 0;

  // Pick the next file to load: a file overlapping the user's current window
  // first (read live, so brushing reprioritizes mid-scan), else plan order.
  function takeNext(): ParsedKey | null {
    const w = getWindow();
    if (w) {
      for (let i = 0; i < queue.length; i++) {
        const f = queue[i];
        if (f && overlapsRange(f, w[0], w[1])) {
          queue[i] = null;
          return f;
        }
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i];
      if (f) {
        queue[i] = null;
        return f;
      }
    }
    return null;
  }

  async function worker(): Promise<void> {
    for (;;) {
      const file = takeNext();
      if (!file || failed) return;
      try {
        // Finalized files are immutable: ETag-checked cache hits skip S3
        // entirely (SPEC §8). _current snapshots are never cached.
        const { result, fromCache } = await fetchAndParse(bucket, file, mem);
        parsedBytes += result.byteLength;
        store.registerFile(file, result.byteLength);
        store.addBatch(result.records);
        store.setProgress({
          filesDone: store.progress.filesDone + 1,
          bytesDone: store.progress.bytesDone + file.size,
          filesFromCache: store.progress.filesFromCache + (fromCache ? 1 : 0),
        });
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, plan.files.length) }, () => worker()),
  );

  store.sortByTime();
  store.setProgress({ running: false, error: failed });
  doneScan({
    detail:
      `${plan.files.length} files (${store.progress.filesFromCache} cached)` +
      (failed ? ` — failed: ${failed}` : ''),
    bytes: parsedBytes,
    records: store.records.length,
  });
  if (cacheLimitBytes != null) await enforceCacheLimit(bucket.bucket, cacheLimitBytes);
}

/** Load one file into the store (inspector "load" action) — cache-aware. */
export async function loadOneFile(
  store: Store,
  bucket: LogBucket,
  file: ParsedKey,
  cacheLimitBytes: number | null,
  mem: MemBytes,
): Promise<void> {
  const { result } = await fetchAndParse(bucket, file, mem);
  store.registerFile(file, result.byteLength);
  store.replaceFile(file.key, result.records);
  if (cacheLimitBytes != null) await enforceCacheLimit(bucket.bucket, cacheLimitBytes);
}
