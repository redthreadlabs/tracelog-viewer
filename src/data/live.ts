/**
 * Live mode (SPEC §5, §6.0): on a 60 s cadence, re-list today's interval
 * prefix for the selected channels and refetch only files whose ETag
 * changed since the last tick (cheaper than conditional GETs — the listing
 * already carries the ETags). Records are patched into the store by source
 * key, and a `_current` snapshot superseded by its finalized file is purged
 * (§3.5: never load both).
 */
import type { LogBucket } from '../s3/client';
import { parseKey } from '../s3/keys';
import { parseFile } from './parse';
import { store } from './store';
import { utcToday } from '../ui/format';

export const LIVE_INTERVAL_MS = 60_000;

export class LiveUpdater {
  private bucket: LogBucket;
  private channels: () => string[];
  private etags = new Map<string, string>();
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
    this.etags.clear();
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
          const parsed = parseKey(obj.key, obj.size, obj.lastModified);
          if (parsed && !parsed.current) {
            finalizedSiblings.add(`${parsed.channel}/${parsed.interval}/${parsed.host}/${parsed.seq}`);
          }
        }
        for (const obj of listing) {
          const parsed = parseKey(obj.key, obj.size, obj.lastModified);
          if (!parsed) continue;
          // a _current shadowed by its finalized file: purge, never load (§3.5)
          if (
            parsed.current &&
            finalizedSiblings.has(`${parsed.channel}/${parsed.interval}/${parsed.host}/${parsed.seq}`)
          ) {
            if (this.etags.has(parsed.key)) {
              store.replaceFile(parsed.key, []);
              this.etags.delete(parsed.key);
            }
            continue;
          }
          const etag = obj.etag ?? '';
          if (this.etags.get(parsed.key) === etag) continue;
          const bytes = await this.bucket.getObjectBytes(parsed.key);
          const { records } = parseFile(bytes, parsed);
          store.replaceFile(parsed.key, records);
          this.etags.set(parsed.key, etag);
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
