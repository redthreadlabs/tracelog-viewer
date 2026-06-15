/**
 * The tab's thin client to the worker-side store (worker/backend.ts).
 * Request/response over postMessage with a mirrored snapshot for sync
 * reads; 'data'/'progress' events re-dispatch locally so views keep their
 * subscribe-and-rerender shape, and worker perf entries land in this tab's
 * perf log (tagged) so #/internals/perf tells the whole story.
 */
import type { Profile } from '../ui/profiles';
import type { Snapshot, Outbound } from '../worker/backend';
import { perf, type PerfEntry } from './perf';

const EMPTY_SNAPSHOT: Snapshot = {
  generation: 0,
  recordCount: 0,
  kindCounts: new Map(),
  channelCounts: new Map(),
  hosts: [],
  files: [],
  progress: {
    filesTotal: 0,
    filesDone: 0,
    bytesDone: 0,
    bytesTotal: 0,
    bytesUncompressedDone: 0,
    bytesUncompressedTotal: 0,
    filesFromCache: 0,
    running: false,
  },
};

export class StoreClient extends EventTarget {
  snapshot: Snapshot = EMPTY_SNAPSHOT;
  private port: MessagePort | Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private ensurePort(): MessagePort | Worker {
    if (this.port) return this.port;
    // the URL expressions stay inline: Vite's static analysis finds worker
    // entry points only in `new (Shared)Worker(new URL(...))` form
    if (typeof SharedWorker !== 'undefined') {
      const shared = new SharedWorker(new URL('../worker/store.worker.ts', import.meta.url), {
        type: 'module',
        name: 'tracelog-store',
      });
      shared.port.start();
      this.port = shared.port;
    } else {
      this.port = new Worker(new URL('../worker/store.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    this.port.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as Outbound);
    return this.port;
  }

  private onMessage(msg: Outbound): void {
    if ('ev' in msg) {
      if (msg.ev === 'perf') {
        perf.push({ ...msg.entry, name: `⚙ ${msg.entry.name}` } as PerfEntry);
        return;
      }
      this.snapshot = msg.snapshot;
      this.dispatchEvent(new Event(msg.ev));
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error));
  }

  request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const port = this.ensurePort();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ id, op, args });
    });
  }

  /** Join (or create) the worker session for this profile. */
  async attach(profile: Profile): Promise<void> {
    const port = this.ensurePort();
    const id = this.nextId++;
    const snapshot = await new Promise<Snapshot>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ id, op: 'attach', profile });
    });
    this.snapshot = snapshot;
    this.dispatchEvent(new Event('data'));
    this.dispatchEvent(new Event('progress'));
  }
}

export const storeClient = new StoreClient();
