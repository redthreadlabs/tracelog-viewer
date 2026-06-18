/**
 * Live mode (SPEC §5, §6.0): on a 60 s cadence, re-list today's interval
 * prefix for the selected channels and refetch only files whose ETag
 * changed (the listing already carries the ETags).
 *
 * Tracelog files are append-only (§3.5: a `_current` snapshot's contents
 * are a prefix of its successor), so a re-fetched snapshot is parsed
 * incrementally: we remember the previous decompressed byte length and the
 * 64 bytes before that boundary, and when the new bytes match — verified,
 * never assumed — only the tail is decoded and parsed (with the metadata
 * context carried over) and appended to the store. Decoding only the tail
 * also means the new records' rawLine slices share a parent string of just
 * the new lines, instead of re-retaining the whole file every tick. Any
 * mismatch (writer restarted, file shrank, no newline at the boundary)
 * falls back to a full re-parse and replace.
 */
import type { LogBucket } from '../s3/client';
import { parseKey, type ParsedKey } from '../s3/keys';
import { parseFile } from './parse';
import type { FileMeta } from './types';
import type { Store } from './store';
import { perf } from './perf';
import { utcToday } from '../ui/format';
import { pushMtime, isCurrent, nextPollDelay } from './cadence';
import { recordMtimes } from './ledger';

/** Discovery LIST cadence — finds new hosts (deploys), rollovers, shadowed
 *  `_current`s. Membership only; the per-host conditional GETs carry the data. */
export const DISCOVERY_CADENCE_MS = 60_000;

const TAIL_CHECK_BYTES = 64;

export interface FileState {
  etag: string;
  /** decompressed byte length at last parse */
  byteLen: number;
  /** copy of the last TAIL_CHECK_BYTES bytes before the boundary */
  tail: Uint8Array;
  /** metadata context in effect at end-of-file */
  lastMeta: FileMeta;
  /** rolling window of distinct S3 LastModified values for a `_current` file —
   *  the live update cadence (SPEC §6.0; data/cadence.ts). Empty for finalized. */
  mtimes: number[];
}

/**
 * Decide how to parse a re-fetched snapshot: returns the tail bytes when
 * the previous content is verifiably a prefix of the new bytes (and the
 * boundary sits on a line break), or null to force a full re-parse.
 */
export function appendPlan(prev: FileState, bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < prev.byteLen) return null; // shrank: writer restarted
  if (prev.byteLen === 0 || prev.tail.length === 0) return null;
  if (prev.tail[prev.tail.length - 1] !== 0x0a) return null; // boundary not on '\n'
  const from = prev.byteLen - prev.tail.length;
  if (from < 0) return null;
  for (let i = 0; i < prev.tail.length; i++) {
    if (bytes[from + i] !== prev.tail[i]) return null; // not a prefix
  }
  return bytes.subarray(prev.byteLen);
}

export function takeTail(bytes: Uint8Array): Uint8Array {
  const n = Math.min(TAIL_CHECK_BYTES, bytes.length);
  return bytes.slice(bytes.length - n); // copy — must not retain the buffer
}

export class LiveUpdater {
  private store: Store;
  private bucket: LogBucket;
  private channels: () => string[];
  /** the hosts to actively watch (null = all). Set by the scanbar via setLive:
   *  the selected manual subset, or the resolved live set in "all current" mode.
   *  A host outside this set is not fetched — but its already-loaded records are
   *  KEPT in the store (we stop watching, we don't erase). */
  private hosts: () => string[] | null;
  private states = new Map<string, FileState>();
  /** keys we're actively polling → their parsed key (membership source of truth) */
  private watched = new Map<string, ParsedKey>();
  /** per-key consecutive-304 count, for the conditional-GET back-off */
  private misses = new Map<string, number>();
  /** per-key scheduled conditional-GET timer (a `handle`, per naming) */
  private fetchHandles = new Map<string, ReturnType<typeof setTimeout>>();
  /** the slow discovery LIST timer */
  private discoverHandle: ReturnType<typeof setInterval> | null = null;
  private discovering = false;

  constructor(
    store: Store,
    bucket: LogBucket,
    channels: () => string[],
    hosts: () => string[] | null = () => null,
  ) {
    this.store = store;
    this.bucket = bucket;
    this.channels = channels;
    this.hosts = hosts;
  }

  get running(): boolean {
    return this.discoverHandle !== null;
  }

  start(): void {
    if (this.discoverHandle) return;
    void this.discover();
    this.discoverHandle = setInterval(() => void this.discover(), DISCOVERY_CADENCE_MS);
  }

  stop(): void {
    if (this.discoverHandle) {
      clearInterval(this.discoverHandle);
      this.discoverHandle = null;
    }
    for (const h of this.fetchHandles.values()) clearTimeout(h);
    this.fetchHandles.clear();
    this.watched.clear();
    this.misses.clear();
    this.states.clear();
  }

  /**
   * Discovery tier (SPEC §6.0, phase 3): a slow LIST per channel that finds the
   * watched `_current` files, starts a per-host conditional-GET loop for each new
   * one, and reaps loops whose host left the watch set or whose `_current`
   * finalized / rolled over. It never fetches data — the per-host loops do.
   */
  private async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const today = utcToday();
      const hostFilter = this.hosts();
      const allow = hostFilter ? new Set(hostFilter) : null; // null = all hosts
      const liveKeys = new Set<string>();
      for (const channel of this.channels()) {
        let listing;
        try {
          listing = await this.bucket.listChannelRange(channel, today, today);
        } catch {
          continue; // transient — next discovery retries
        }
        const finalized = new Set<string>();
        for (const obj of listing) {
          const p = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
          if (p && !p.current) finalized.add(`${p.host}/${p.seq}`);
        }
        for (const obj of listing) {
          const p = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
          if (!p || !p.current) continue;
          // a _current shadowed by its finalized sibling: purge + stop (§3.5)
          if (finalized.has(`${p.host}/${p.seq}`)) {
            if (this.watched.has(p.key)) this.reap(p.key, true);
            continue;
          }
          if (allow && !allow.has(p.host)) continue; // outside the watch set
          liveKeys.add(p.key);
          const isNew = !this.watched.has(p.key);
          this.watched.set(p.key, p); // (re)freshen parsed (size / etag / mtime move)
          if (isNew) this.scheduleFetch(p, 0); // new host → poll now
        }
      }
      // reap loops whose key is no longer a watched live current — host left the
      // set, or rolled to a new interval. KEEP their already-loaded records.
      for (const key of [...this.watched.keys()]) {
        if (!liveKeys.has(key)) this.reap(key, false);
      }
    } finally {
      this.discovering = false;
    }
  }

  private reap(key: string, purgeStore: boolean): void {
    const h = this.fetchHandles.get(key);
    if (h) clearTimeout(h);
    this.fetchHandles.delete(key);
    this.watched.delete(key);
    this.misses.delete(key);
    this.states.delete(key);
    if (purgeStore) this.store.dropFile(key); // only the shadowed-by-finalized case
  }

  private scheduleFetch(parsed: ParsedKey, delayMs: number): void {
    const existing = this.fetchHandles.get(parsed.key);
    if (existing) clearTimeout(existing);
    this.fetchHandles.set(
      parsed.key,
      setTimeout(() => void this.pollHost(parsed), delayMs),
    );
  }

  /**
   * One per-host conditional GET: when the `_current` file changed, apply the
   * delta; a 304 means nothing new. Then reschedule near the next expected flush
   * (or back off if the host has gone quiet). One request, no LIST.
   */
  private async pollHost(parsed: ParsedKey): Promise<void> {
    if (!this.watched.has(parsed.key)) return; // reaped between scheduling + firing
    let changed = false;
    try {
      const prev = this.states.get(parsed.key);
      const res = await this.bucket.getObjectIfChanged(parsed.key, prev?.etag);
      if (res !== 'unchanged') {
        changed = true;
        this.ingest(parsed, res.bytes, res.etag ?? '', res.lastModified ?? parsed.lastModified);
      }
    } catch {
      // transient — treat as a miss; the back-off schedule retries
    }
    if (!this.watched.has(parsed.key)) return; // reaped during the await
    const misses = changed ? 0 : (this.misses.get(parsed.key) ?? 0) + 1;
    this.misses.set(parsed.key, misses);
    const mtimes = this.states.get(parsed.key)?.mtimes ?? [];
    this.scheduleFetch(parsed, nextPollDelay(mtimes, misses, Math.random()));
  }

  /**
   * Apply fetched bytes to the store — a verified tail-append when the previous
   * content is a prefix of the new, else a full replace — and extend the cadence
   * window from the file's LastModified. Factored from the old tick; same rules.
   */
  private ingest(parsed: ParsedKey, bytes: Uint8Array, etag: string, lastModified?: Date): void {
    const prev = this.states.get(parsed.key);
    const tailBytes = prev ? appendPlan(prev, bytes) : null;
    let mtimes = prev?.mtimes ?? [];
    const mt = lastModified?.getTime();
    if (mt) {
      mtimes = pushMtime(mtimes, mt);
      void recordMtimes(
        this.bucket.bucket,
        { key: parsed.key, channel: parsed.channel, interval: parsed.interval, size: parsed.size, etag },
        mtimes,
      );
    }
    const done = perf.begin('live', `live ${parsed.host}`);
    const result = tailBytes
      ? parseFile(tailBytes, parsed, prev!.lastMeta)
      : parseFile(bytes, parsed);
    if (tailBytes) {
      this.store.registerFile(parsed, result.byteLength, true);
      this.store.appendSorted(result.records);
    } else {
      this.store.registerFile(parsed, result.byteLength);
      this.store.replaceFile(parsed.key, result.records);
    }
    this.states.set(parsed.key, {
      etag,
      byteLen: bytes.length,
      tail: takeTail(bytes),
      lastMeta: result.lastMeta,
      mtimes,
    });
    done({ detail: `${parsed.host} +${result.records.length}`, records: result.records.length });
  }

  /**
   * The hosts in `channels` whose current-interval `_current` file is still live
   * — its heartbeat is within the staleness window (data/cadence.ts). Gates the
   * LIVE toggle and resolves the "all current" host selection (SPEC §6.0). Uses
   * the in-memory cadence window when live is running (freshest, real cadence),
   * else bootstraps from the listing's LastModified against the absolute floor.
   * One discovery LIST per channel; `now` should be skew-corrected by the caller.
   */
  async currentHosts(channels: string[], now: number): Promise<string[]> {
    const today = utcToday();
    const hosts = new Set<string>();
    for (const channel of channels) {
      let listing;
      try {
        listing = await this.bucket.listChannelRange(channel, today, today);
      } catch {
        continue; // transient — the caller refreshes on the next change
      }
      // a _current shadowed by its finalized sibling is not live (§3.5)
      const finalized = new Set<string>();
      for (const obj of listing) {
        const p = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
        if (p && !p.current) finalized.add(`${p.host}/${p.seq}`);
      }
      for (const obj of listing) {
        const p = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
        if (!p || !p.current || finalized.has(`${p.host}/${p.seq}`)) continue;
        const mtimes =
          this.states.get(p.key)?.mtimes ?? (p.lastModified ? [p.lastModified.getTime()] : []);
        if (isCurrent(now, mtimes)) hosts.add(p.host);
      }
    }
    return [...hosts].sort();
  }
}
