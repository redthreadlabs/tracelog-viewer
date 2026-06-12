/**
 * The tracelog S3 key grammar (SPEC §3.1, normative):
 *
 *   {channel}/{interval}/{host}[_{seq}][_current].jsonl.gz
 *
 * Hostnames cannot contain underscores, so split('_') on the basename is
 * unambiguous. A `_current` file whose interval is in the past belongs to a
 * host that died mid-interval and is the only copy of its final logs.
 */

export interface ParsedKey {
  key: string;
  channel: string;
  /** `YYYY-MM-DD` (daily) or `YYYY-MM-DDTHH` (hourly). Lexicographic == chronological. */
  interval: string;
  host: string;
  seq: number;
  current: boolean;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export function parseKey(
  key: string,
  size = 0,
  lastModified?: Date,
  etag?: string,
): ParsedKey | null {
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  const [channel, interval, file] = parts;
  if (!channel || !interval || !file) return null;

  let base = file;
  if (base.endsWith('.gz')) base = base.slice(0, -3);
  if (!base.endsWith('.jsonl')) return null;
  base = base.slice(0, -'.jsonl'.length);

  const segments = base.split('_');
  const host = segments[0];
  if (!host) return null;

  let seq = 0;
  let current = false;
  let rest = segments.slice(1);
  if (rest[rest.length - 1] === 'current') {
    current = true;
    rest = rest.slice(0, -1);
  }
  if (rest.length === 1 && /^\d+$/.test(rest[0])) {
    seq = parseInt(rest[0], 10);
  } else if (rest.length > 0) {
    return null; // not the grammar we know — ignore, don't fail (SPEC §3.5)
  }

  return { key, channel, interval, host, seq, current, size, lastModified, etag };
}

/**
 * Drop `_current` snapshots that are shadowed by their finalized file
 * (SPEC §3.5: "if the finalized key exists, ignore the (briefly surviving)
 * `_current`"). A `_current` with no finalized sibling is kept — it is
 * either live (today) or a dead host's only copy.
 */
export function dedupeCurrents(files: ParsedKey[]): ParsedKey[] {
  const finalized = new Set<string>();
  for (const f of files) {
    if (!f.current) finalized.add(`${f.channel}/${f.interval}/${f.host}/${f.seq}`);
  }
  return files.filter(
    (f) => !f.current || !finalized.has(`${f.channel}/${f.interval}/${f.host}/${f.seq}`),
  );
}


/**
 * The UTC time span an interval label covers: daily `YYYY-MM-DD` → 24 h,
 * hourly `YYYY-MM-DDTHH` → 1 h. Unknown grammar → null (callers should be
 * conservative and keep the file).
 */
export function intervalSpan(interval: string): [number, number] | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(interval);
  if (m) {
    const t0 = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return [t0, t0 + 86_400_000];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(interval);
  if (m) {
    const t0 = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
    return [t0, t0 + 3_600_000];
  }
  return null;
}

/**
 * Whether a file's interval overlaps [startMs, endMs]. This is the fetch
 * filter that makes sub-day ranges cheap on hourly buckets: listings stay
 * day-bracketed (correct for daily, hourly, or mixed layouts), but only
 * files whose hours actually cover the range get fetched.
 */
export function overlapsRange(file: ParsedKey, startMs: number, endMs: number): boolean {
  const span = intervalSpan(file.interval);
  if (!span) return true; // unknown layout: keep it
  return span[0] <= endMs && span[1] > startMs;
}
