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
import { parseKey } from '../s3/keys';
import { parseFile } from './parse';
import type { FileMeta } from './types';
import { store } from './store';
import { utcToday } from '../ui/format';

export const LIVE_INTERVAL_MS = 60_000;

const TAIL_CHECK_BYTES = 64;

export interface FileState {
  etag: string;
  /** decompressed byte length at last parse */
  byteLen: number;
  /** copy of the last TAIL_CHECK_BYTES bytes before the boundary */
  tail: Uint8Array;
  /** metadata context in effect at end-of-file */
  lastMeta: FileMeta;
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
  private bucket: LogBucket;
  private channels: () => string[];
  private states = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  lastTick = 0;

  constructor(bucket: LogBucket, channels: () => string[]) {
    this.bucket = bucket;
    this.channels = channels;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), LIVE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.states.clear();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const today = utcToday();
      for (const channel of this.channels()) {
        const listing = await this.bucket.listChannelRange(channel, today, today);
        const finalizedSiblings = new Set<string>();
        for (const obj of listing) {
          const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
          if (parsed && !parsed.current) {
            finalizedSiblings.add(
              `${parsed.channel}/${parsed.interval}/${parsed.host}/${parsed.seq}`,
            );
          }
        }
        for (const obj of listing) {
          const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
          if (!parsed) continue;
          // a _current shadowed by its finalized file: purge, never load (§3.5)
          if (
            parsed.current &&
            finalizedSiblings.has(
              `${parsed.channel}/${parsed.interval}/${parsed.host}/${parsed.seq}`,
            )
          ) {
            if (this.states.has(parsed.key)) {
              store.replaceFile(parsed.key, []);
              this.states.delete(parsed.key);
            }
            continue;
          }
          const etag = obj.etag ?? '';
          const prev = this.states.get(parsed.key);
          if (prev?.etag === etag) continue;

          const bytes = await this.bucket.getObjectBytes(parsed.key);
          const tailBytes = prev ? appendPlan(prev, bytes) : null;

          if (tailBytes) {
            // verified append: parse + append only the new lines
            const result = parseFile(tailBytes, parsed, prev!.lastMeta);
            store.appendSorted(result.records);
            this.states.set(parsed.key, {
              etag,
              byteLen: bytes.length,
              tail: takeTail(bytes),
              lastMeta: result.lastMeta,
            });
          } else {
            const result = parseFile(bytes, parsed);
            store.replaceFile(parsed.key, result.records);
            this.states.set(parsed.key, {
              etag,
              byteLen: bytes.length,
              tail: takeTail(bytes),
              lastMeta: result.lastMeta,
            });
          }
        }
      }
      this.lastTick = Date.now();
    } catch {
      // transient failures are fine; the next tick retries
    } finally {
      this.ticking = false;
    }
  }
}
