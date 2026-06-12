/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import type { ScanPlan } from '../s3/scanner';
import { parseFile } from './parse';
import { cacheGet, cachePut } from './cache';
import { store } from './store';
import { resetViewState } from '../state';

const CONCURRENCY = 4;

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

  const queue = [...plan.files];
  let failed: string | undefined;

  async function worker(): Promise<void> {
    for (;;) {
      const file = queue.shift();
      if (!file || failed) return;
      try {
        // Finalized files are immutable: ETag-checked cache hits skip S3
        // entirely (SPEC §8). _current snapshots are never cached.
        let bytes = file.current ? null : await cacheGet(file.key, file.etag);
        const fromCache = bytes !== null;
        if (!bytes) {
          bytes = await bucket.getObjectBytes(file.key);
          if (!file.current) void cachePut(file.key, file.etag, bytes);
        }
        const result = parseFile(bytes, file);
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
}
