/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import type { ScanPlan } from '../s3/scanner';
import { parseFile } from './parse';
import { store } from './store';

const CONCURRENCY = 4;

export async function executeScan(bucket: LogBucket, plan: ScanPlan): Promise<void> {
  store.clear();
  store.setProgress({
    filesTotal: plan.files.length,
    filesDone: 0,
    bytesDone: 0,
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
        const bytes = await bucket.getObjectBytes(file.key);
        const { records } = parseFile(bytes, file);
        store.addBatch(records);
        store.setProgress({
          filesDone: store.progress.filesDone + 1,
          bytesDone: store.progress.bytesDone + file.size,
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
