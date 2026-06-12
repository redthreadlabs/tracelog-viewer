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
}

export function parseKey(key: string, size = 0, lastModified?: Date): ParsedKey | null {
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

  return { key, channel, interval, host, seq, current, size, lastModified };
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
