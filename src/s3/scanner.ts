/**
 * Scan planning (SPEC §3.2 + §6.0): a plan is computed from listings alone,
 * so the download budget ("would fetch 14 files / ~3.2 MB") is shown before
 * a single object byte is fetched.
 */
import type { LogBucket } from './client';
import { parseKey, dedupeCurrents, overlapsRange, type ParsedKey } from './keys';
import { perf } from '../data/perf';

export interface ScanPlan {
  files: ParsedKey[];
  totalBytes: number;
  hosts: string[];
  channels: string[];
}

export async function planScan(
  bucket: LogBucket,
  channels: string[],
  startMs: number,
  endMs: number,
): Promise<ScanPlan> {
  const donePlan = perf.begin('list', `plan ${channels.join(',')}`);
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const all: ParsedKey[] = [];
  // Channels are few (SPEC: cross-channel queries fan out over the
  // discovered channels) — fan out the per-channel listings concurrently.
  // Listings stay day-bracketed (correct for daily, hourly, and mixed
  // layouts); the overlap filter below keeps fetches hour-granular.
  const listings = await Promise.all(
    channels.map((ch) => bucket.listChannelRange(ch, startDate, endDate)),
  );
  for (const listing of listings) {
    for (const obj of listing) {
      const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
      if (parsed && overlapsRange(parsed, startMs, endMs)) all.push(parsed);
    }
  }

  const files = dedupeCurrents(all).sort((a, b) =>
    a.interval === b.interval ? a.key.localeCompare(b.key) : a.interval.localeCompare(b.interval),
  );

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  donePlan({
    detail: `${startDate}..${endDate} → ${files.length} files`,
    bytes: totalBytes,
  });

  return {
    files,
    totalBytes,
    hosts: [...new Set(files.map((f) => f.host))].sort(),
    channels: [...new Set(files.map((f) => f.channel))].sort(),
  };
}
