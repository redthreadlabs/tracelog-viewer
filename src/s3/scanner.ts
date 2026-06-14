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
  /** hosts present in the (host-filtered) plan */
  hosts: string[];
  /** every host available for these channels+range, before the host filter —
   *  the candidate set the host picker chooses from */
  allHosts: string[];
  channels: string[];
}

/**
 * Build a scan plan from listings. The working set is (channels × hosts × time
 * range): `hosts === undefined` means all hosts; a list narrows to those hosts;
 * `[]` means none (an empty plan), mirroring the channel contract.
 */
export async function planScan(
  bucket: LogBucket,
  channels: string[],
  startMs: number,
  endMs: number,
  hosts?: string[],
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

  // all candidate hosts (before the host filter) — the picker chooses from this
  const allHosts = [...new Set(all.map((f) => f.host))].sort();
  // host filter: undefined → all; a list → only those; [] → none
  const hostSet = hosts === undefined ? null : new Set(hosts);
  const filtered = hostSet ? all.filter((f) => hostSet.has(f.host)) : all;

  // Newest intervals first: stream-render fills the most recent (most
  // relevant) data in first and works backward through the range. Within
  // an interval, key order keeps the plan deterministic.
  const files = dedupeCurrents(filtered).sort((a, b) =>
    a.interval === b.interval ? a.key.localeCompare(b.key) : b.interval.localeCompare(a.interval),
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
    allHosts,
    channels: [...new Set(files.map((f) => f.channel))].sort(),
  };
}
