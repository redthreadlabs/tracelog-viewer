/**
 * Scan planning (SPEC §3.2 + §6.0): a plan is computed from listings alone,
 * so the download budget ("would fetch 14 files / ~3.2 MB") is shown before
 * a single object byte is fetched.
 */
import type { LogBucket } from './client';
import { parseKey, dedupeCurrents, type ParsedKey } from './keys';

export interface ScanPlan {
  files: ParsedKey[];
  totalBytes: number;
  hosts: string[];
  channels: string[];
}

export async function planScan(
  bucket: LogBucket,
  channels: string[],
  startDate: string,
  endDate: string,
): Promise<ScanPlan> {
  const all: ParsedKey[] = [];
  // Channels are few (SPEC: cross-channel queries fan out over the
  // discovered channels) — fan out the per-channel listings concurrently.
  const listings = await Promise.all(
    channels.map((ch) => bucket.listChannelRange(ch, startDate, endDate)),
  );
  for (const listing of listings) {
    for (const obj of listing) {
      const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
      if (parsed) all.push(parsed);
    }
  }

  const files = dedupeCurrents(all).sort((a, b) =>
    a.interval === b.interval ? a.key.localeCompare(b.key) : a.interval.localeCompare(b.interval),
  );

  return {
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    hosts: [...new Set(files.map((f) => f.host))].sort(),
    channels: [...new Set(files.map((f) => f.channel))].sort(),
  };
}
