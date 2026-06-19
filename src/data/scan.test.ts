/**
 * Working-set loader (LoadController) corner cases. The fetch step is injected
 * (a controllable mock with one deferred promise per file) so we can freeze the
 * loader mid-flight and assert exactly what it did: which files it started, what
 * it cancelled, what it kept, and what its progress reports.
 *
 * A *working set* is the files implied by the selection (channels × range),
 * narrowed by any zoom window. The loader pursues that set; a window change
 * re-scopes it (cancel pending, keep in-flight + loaded), a new plan resets it.
 */
import { describe, it, expect } from 'vitest';
import { LoadController, CONCURRENCY, type FileLoader } from './scan';
import { Store } from './store';
import type { LogBucket } from '../s3/client';
import type { ParsedKey } from '../s3/keys';
import type { Rec } from './types';

const BUCKET = { bucket: 'test' } as unknown as LogBucket;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 5, 10, 0); // 2026-06-10T00:00Z

/** A finalized hourly file whose interval span is exactly [BASE+h·H, +1h). */
function hourKey(h: number, channel = 'server'): ParsedKey {
  const hh = String(h).padStart(2, '0');
  return {
    key: `${channel}/2026-06-10/h0.${hh}.jsonl.gz`,
    channel,
    interval: `2026-06-10T${hh}`,
    host: 'h0',
    seq: 0,
    current: false,
    size: 100,
  };
}
const k = (h: number) => hourKey(h).key;
const plan = (hours: number[], channel = 'server') => hours.map((h) => hourKey(h, channel));
/** A window strictly inside hour h, so it overlaps that hour and no neighbour. */
const hourWindow = (h: number): [number, number] => [BASE + h * HOUR + HOUR * 0.2, BASE + h * HOUR + HOUR * 0.8];

/** drain the microtask queue so a resolved load's continuation + re-pump run */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeHarness(
  initialWindow: [number, number] | null = null,
  memoryLimitBytes: number | null = null,
) {
  const store = new Store();
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (m: string) => void }>();
  let win = initialWindow;

  const loadFile: FileLoader = (file) => {
    started.push(file.key);
    return new Promise((resolve, reject) => {
      pending.set(file.key, {
        resolve: () =>
          resolve({
            records: [makeRec(file)],
            byteLength: file.size,
            fromCache: false,
          }),
        reject: (m) => reject(new Error(m)),
      });
    });
  };

  const controller = new LoadController(store, BUCKET, null, memoryLimitBytes, () => win, loadFile);

  return {
    store,
    controller,
    started,
    reset: (hours: number[], window: [number, number] | null = win) => {
      win = window;
      controller.reset(plan(hours));
    },
    setPlan: (hours: number[], channel = 'server', window: [number, number] | null = win) => {
      win = window;
      controller.setPlan(plan(hours, channel));
    },
    setWindow: (window: [number, number] | null) => {
      win = window;
      controller.resync();
    },
    complete: async (fileKey: string) => {
      const p = pending.get(fileKey);
      if (!p) throw new Error(`not in flight: ${fileKey}`);
      pending.delete(fileKey);
      p.resolve();
      await flush();
    },
    fail: async (fileKey: string, msg: string) => {
      const p = pending.get(fileKey);
      if (!p) throw new Error(`not in flight: ${fileKey}`);
      pending.delete(fileKey);
      p.reject(msg);
      await flush();
    },
    inFlight: () => [...pending.keys()],
    sourceKeys: () => new Set(store.records.map((r) => r.sourceKey)),
  };
}

function makeRec(file: ParsedKey): Rec {
  return {
    id: Math.random(),
    kind: 'event',
    ts: Date.UTC(2026, 5, 10, +file.interval.slice(-2)), // hour start
    channel: file.channel,
    host: file.host,
    sourceKey: file.key,
    meta: {},
    name: 'x',
    rawLine: '',
    line: 0,
  };
}

describe('LoadController working-set scoping', () => {
  it('loads only files overlapping the window, not the whole plan', async () => {
    const h = makeHarness(hourWindow(2));
    h.reset([0, 1, 2, 3, 4, 5]);
    // only hour 2 overlaps the window — nothing else is even started
    expect(h.started).toEqual([k(2)]);
    await h.complete(k(2));
    expect(h.sourceKeys()).toEqual(new Set([k(2)]));
    expect(h.store.progress.running).toBe(false);
  });

  it('with no window, loads the whole plan capped at CONCURRENCY in flight', async () => {
    const h = makeHarness(null);
    h.reset([5, 4, 3, 2, 1, 0]); // newest-first plan order
    expect(h.started).toEqual([k(5), k(4), k(3), k(2)]); // 4 in flight, newest first
    expect(h.started.length).toBe(CONCURRENCY);
    await h.complete(k(5)); // a slot frees → the next plan file starts
    expect(h.started).toEqual([k(5), k(4), k(3), k(2), k(1)]);
  });
});

describe('LoadController re-scope on zoom', () => {
  it('cancels still-pending out-of-set files but keeps in-flight ones', async () => {
    const h = makeHarness(null);
    h.reset([5, 4, 3, 2, 1, 0]); // 5,4,3,2 in flight; 1,0 pending (CONCURRENCY=4)
    h.setWindow(hourWindow(5)); // working set shrinks to hour 5 only

    // 1 and 0 were pending and out of the new set → never started (cancelled);
    // 4,3,2 are in flight (out of the new window) → not aborted
    await h.complete(k(5));
    await h.complete(k(4));
    await h.complete(k(3));
    await h.complete(k(2));

    expect(h.started).toEqual([k(5), k(4), k(3), k(2)]);
    expect(h.sourceKeys()).toEqual(new Set([k(5), k(4), k(3), k(2)])); // in-flight kept
    expect(h.store.files.has(k(1))).toBe(false);
    expect(h.store.files.has(k(0))).toBe(false);
  });

  it('never evicts a file already loaded when the window moves off it', async () => {
    const h = makeHarness(hourWindow(0));
    h.reset([0, 5], hourWindow(0)); // working set = hour 0
    await h.complete(k(0)); // hour 0 loaded

    h.setWindow(hourWindow(5)); // zoom away to hour 5
    expect(h.store.files.has(k(0))).toBe(true); // hour 0 stays loaded
    await h.complete(k(5));
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(5)]));
  });

  it('widening the window re-pumps and resumes loading', async () => {
    const h = makeHarness(hourWindow(0));
    h.reset([5, 4, 3, 2, 1, 0], hourWindow(0));
    expect(h.started).toEqual([k(0)]); // only hour 0 in the window
    await h.complete(k(0));
    expect(h.store.progress.running).toBe(false); // working set drained, idle

    h.setWindow(null); // widen to the full plan
    expect(h.store.progress.running).toBe(true); // resumed
    // hour 0 already loaded → it picks the next-newest unloaded, up to CONCURRENCY
    expect(h.started).toEqual([k(0), k(5), k(4), k(3), k(2)]);
  });
});

describe('LoadController progress denominator', () => {
  it('tracks the working set, shrinking on zoom and counting only in-set files', async () => {
    const h = makeHarness(null);
    h.reset([5, 4, 3, 2, 1, 0]);
    expect(h.store.progress.bytesTotal).toBe(600); // 6 × 100
    expect(h.store.progress.filesTotal).toBe(6);

    h.setWindow(hourWindow(2)); // zoom to hour 2
    expect(h.store.progress.bytesTotal).toBe(100); // denominator collapses
    expect(h.store.progress.filesTotal).toBe(1);

    // finish every in-flight load (hour 2 in-set, 5/4/3 out-of-set but kept)
    await h.complete(k(2));
    await h.complete(k(5));
    await h.complete(k(4));
    await h.complete(k(3));

    // progress reflects only the working set (hour 2), not all that got loaded
    expect(h.store.progress.bytesDone).toBe(100);
    expect(h.store.progress.filesDone).toBe(1);
    expect(h.store.progress.bytesTotal).toBe(100);
    expect(h.store.progress.running).toBe(false);
    expect(h.store.records.length).toBe(4); // but the store does hold all four
  });
});

describe('LoadController new-plan reset', () => {
  it('discards a stale in-flight result from the previous plan', async () => {
    const h = makeHarness(null);
    h.reset([0]); // plan A: hour 0 in flight
    h.reset([1]); // plan B (new plan) — clears the store, bumps the epoch

    await h.complete(k(1)); // plan B's file lands → kept
    await h.complete(k(0)); // plan A's straggler lands → discarded (epoch moved)

    expect(h.sourceKeys()).toEqual(new Set([k(1)]));
  });

  it('clears the record store on a new plan', async () => {
    const h = makeHarness(null);
    h.reset([0]);
    await h.complete(k(0));
    expect(h.store.records.length).toBe(1);

    h.reset([1]); // new plan clears immediately
    expect(h.store.records.length).toBe(0);
  });
});

describe('LoadController completion', () => {
  it('time-sorts the store once the working set drains', async () => {
    const h = makeHarness(null);
    h.reset([5, 0]); // both in flight (under CONCURRENCY)
    await h.complete(k(5)); // later ts appended first
    await h.complete(k(0)); // earlier ts appended second → out of order
    expect(h.store.records.map((r) => r.ts)).toEqual([BASE, BASE + 5 * HOUR]);
  });

  it('surfaces a failed load as a progress error and stops', async () => {
    const h = makeHarness(null);
    h.reset([0]);
    await h.fail(k(0), 'boom');
    expect(h.store.progress.error).toBe('boom');
    expect(h.store.progress.running).toBe(false);
  });
});

describe('LoadController setPlan (incremental, keep-on-narrow)', () => {
  it('keeps parsed records on a range change (same channels) and re-loads nothing', async () => {
    const h = makeHarness(null);
    h.setPlan([0, 1], 'server');
    await h.complete(k(0));
    await h.complete(k(1));
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)]));
    h.started.length = 0;
    // narrow the plan to just hour 0 — same channels → additive: nothing is
    // fetched, and hour 1's records are KEPT (not unloaded)
    h.setPlan([0], 'server');
    expect(h.started).toEqual([]);
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)]));
  });

  it('only fetches the delta when the range widens', async () => {
    const h = makeHarness(null);
    h.setPlan([0], 'server');
    await h.complete(k(0));
    h.started.length = 0;
    h.setPlan([0, 1, 2], 'server'); // same channels, wider range
    expect(h.started).toEqual([k(1), k(2)]); // hour 0 already loaded → only 1,2
  });

  it('keeps records on a channel change — additive, never a wipe (selection is a view)', async () => {
    const h = makeHarness(null);
    h.setPlan([0, 1], 'server');
    await h.complete(k(0));
    await h.complete(k(1));
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)]));
    h.started.length = 0;
    // a DIFFERENT channel is just a different view over the loaded data: the
    // 'server' records are KEPT (the solver scopes them out of queries; only the
    // memory limit evicts), and the loader pursues the newly-selected file.
    h.setPlan([0], 'other');
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)])); // not wiped
    expect(h.started).toEqual([plan([0], 'other')[0].key]); // new channel fetched
  });
});

describe('LoadController record eviction (memory limit)', () => {
  it('evicts the least-recently-in-set out-of-set file when over the limit', async () => {
    const h = makeHarness(null, 250); // ~2 files of 100 fit
    h.setPlan([0, 1], 'server', null); // working set = hours 0,1
    await h.complete(k(0));
    await h.complete(k(1));
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)])); // 200 ≤ 250

    h.setWindow(hourWindow(0)); // hour 1 leaves the set but is KEPT (still under)
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)]));

    // load hour 2 → 300 > 250, evict the LRU out-of-set file. hour 0 was just
    // refreshed by the narrow, so hour 1 (least recent) goes; 0 and 2 survive.
    h.setPlan([0, 1, 2], 'server', hourWindow(2));
    await h.complete(k(2));
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(2)]));
  });

  it('never evicts a file that is in the working set', async () => {
    const h = makeHarness(null, 150); // limit fits ~1, but the set needs 2
    h.setPlan([0, 1], 'server', null);
    await h.complete(k(0));
    await h.complete(k(1));
    // the working set itself (200) exceeds the limit — eviction can't touch
    // in-set files (that's the load clamp's job), so both stay
    expect(h.sourceKeys()).toEqual(new Set([k(0), k(1)]));
  });
});
