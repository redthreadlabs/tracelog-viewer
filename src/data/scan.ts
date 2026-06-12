/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import type { ScanPlan } from '../s3/scanner';
import type { ParsedKey } from '../s3/keys';
import { parseFile } from './parse';
import { cacheGet, cachePut } from './cache';
import { store } from './store';
import { perf } from './perf';
import { resetViewState } from '../state';

const CONCURRENCY = 4;

/** Fetch one file's bytes (IndexedDB first), parse it, and time both. */
async function fetchAndParse(
  bucket: LogBucket,
  file: ParsedKey,
): Promise<{ result: ReturnType<typeof parseFile>; fromCache: boolean }> {
  const doneFetch = perf.begin('fetch', file.key);
  let bytes = file.current ? null : await cacheGet(bucket.bucket, file.key, file.etag);
  const fromCache = bytes !== null;
  if (!bytes) {
    bytes = await bucket.getObjectBytes(file.key);
    if (!file.current) void cachePut(bucket.bucket, file.key, file.etag, bytes);
  }
  doneFetch({ bytes: bytes.length, cached: fromCache });

  const doneParse = perf.begin('parse', file.key);
  const result = parseFile(bytes, file);
  doneParse({ bytes: result.byteLength, records: result.records.length });
  return { result, fromCache };
}

export async function executeScan(bucket: LogBucket, plan: ScanPlan): Promise<void> {
  store.clear();
  resetViewState(); // a new scan invalidates any brushed window / deep link
  store.setProgress({
    filesTotal: plan.files.length,
    filesDone: 0,
    bytesDone: 0,
    filesFromCache: 0,
    running: true,
    error: undefined,
  });

  const doneScan = perf.begin('scan', `scan s3://${bucket.bucket}`);
  const queue = [...plan.files];
  let failed: string | undefined;
  let parsedBytes = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const file = queue.shift();
      if (!file || failed) return;
      try {
        // Finalized files are immutable: ETag-checked cache hits skip S3
        // entirely (SPEC §8). _current snapshots are never cached.
        const { result, fromCache } = await fetchAndParse(bucket, file);
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
}

/** Load one file into the store (inspector "load" action) — cache-aware. */
export async function loadOneFile(bucket: LogBucket, file: ParsedKey): Promise<void> {
  const { result } = await fetchAndParse(bucket, file);
  store.registerFile(file, result.byteLength);
  store.replaceFile(file.key, result.records);
}
