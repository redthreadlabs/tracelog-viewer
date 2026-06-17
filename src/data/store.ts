/**
 * In-memory record store (SPEC §5). Views render from here and subscribe to
 * updates; the scan layer appends batches as files land so views populate
 * incrementally (stream-render, SPEC §7).
 */
import type { Rec, RecordKind } from './types';
import type { ParsedKey } from '../s3/keys';
import { perf } from './perf';

/**
 * Per-file index bundle (SPEC §5, §8): the logfile is the root unit of
 * memory management, so every index lives inside its file's bundle —
 * dropping the file drops the indexes, and everything GCs together. The
 * arrays hold references to the same Rec objects as `records`; the cost
 * is pointers, not copies. Cross-file queries (Store.kindRecords,
 * transactionsNamed, traceRecords) merge bundles on demand.
 */
interface FileIndex {
  /** records of this file, in arrival (≈ time) order */
  records: Rec[];
  byKind: Map<RecordKind, Rec[]>;
  /** transactions only, keyed by transaction name */
  txnsByName: Map<string, Rec[]>;
  /** every record carrying a trace_id (txns, spans, errors, events) */
  byTrace: Map<string, Rec[]>;
}

function emptyIndex(): FileIndex {
  return { records: [], byKind: new Map(), txnsByName: new Map(), byTrace: new Map() };
}

function push<K>(map: Map<K, Rec[]>, key: K, rec: Rec): void {
  const list = map.get(key);
  if (list) list.push(rec);
  else map.set(key, [rec]);
}

/** What the store knows about one loaded source file (for the inspector). */
export interface FileInfo {
  key: string;
  channel: string;
  interval: string;
  host: string;
  current: boolean;
  /** compressed object size from the listing */
  sizeCompressed: number;
  /** decompressed bytes parsed (grows for live-appended snapshots) */
  sizeUncompressed: number;
  /** S3 Last-Modified from the listing, epoch-ms */
  lastModified?: number;
}

export interface ScanProgress {
  filesTotal: number;
  filesDone: number;
  /** COMPRESSED (gzip / listing) bytes loaded so far — the memory-budget currency
   *  + what the load indicator shows (the heap proxy; SPEC §8) */
  bytesDone: number;
  /** total compressed bytes of the current working set — the load denominator */
  bytesTotal: number;
  filesFromCache: number;
  running: boolean;
  error?: string;
}

export class Store extends EventTarget {
  records: Rec[] = [];
  kindCounts = new Map<RecordKind, number>();
  channelCounts = new Map<string, number>();
  levelCounts = new Map<string, number>();
  hosts = new Set<string>();
  files = new Map<string, FileInfo>();
  progress: ScanProgress = {
    filesTotal: 0,
    filesDone: 0,
    bytesDone: 0,
    bytesTotal: 0,
    filesFromCache: 0,
    running: false,
  };

  /** monotonically increasing; views compare to know the data changed */
  generation = 0;

  private fileIndexes = new Map<string, FileIndex>();
  /** merged per-kind arrays, memoized per generation (built on first use) */
  private kindCache = new Map<RecordKind, { gen: number; arr: Rec[] }>();

  private indexBatch(batch: Rec[]): void {
    for (const rec of batch) {
      let index = this.fileIndexes.get(rec.sourceKey);
      if (!index) {
        index = emptyIndex();
        this.fileIndexes.set(rec.sourceKey, index);
      }
      index.records.push(rec);
      push(index.byKind, rec.kind, rec);
      if (rec.kind === 'transaction') push(index.txnsByName, rec.name, rec);
      if (rec.traceId) push(index.byTrace, rec.traceId, rec);
    }
  }

  /**
   * All records of one kind, time-sorted, merged across files. Memoized per
   * generation: the first caller after a data change pays one merge+sort,
   * everyone else reads it free.
   */
  kindRecords(kind: RecordKind): Rec[] {
    const hit = this.kindCache.get(kind);
    if (hit && hit.gen === this.generation) return hit.arr;
    const arr: Rec[] = [];
    for (const index of this.fileIndexes.values()) {
      const list = index.byKind.get(kind);
      if (list) for (const rec of list) arr.push(rec);
    }
    arr.sort((a, b) => a.ts - b.ts);
    this.kindCache.set(kind, { gen: this.generation, arr });
    return arr;
  }

  /** All transactions with this name, time-sorted (drill-down page). */
  transactionsNamed(name: string): Rec[] {
    const arr: Rec[] = [];
    for (const index of this.fileIndexes.values()) {
      const list = index.txnsByName.get(name);
      if (list) for (const rec of list) arr.push(rec);
    }
    return arr.sort((a, b) => a.ts - b.ts);
  }

  /** One loaded file's records, in arrival order (≈ time). Lets the solver
   *  build an aggregate index in memory for a file that isn't persisted — the
   *  `_current` interval is never indexed at parse time but is always loaded
   *  while it overlaps the working set. Empty if the file isn't loaded. */
  recordsOf(sourceKey: string): Rec[] {
    return this.fileIndexes.get(sourceKey)?.records ?? [];
  }

  /** Every record of one trace, time-sorted (waterfall assembly). */
  traceRecords(traceId: string): Rec[] {
    const arr: Rec[] = [];
    for (const index of this.fileIndexes.values()) {
      const list = index.byTrace.get(traceId);
      if (list) for (const rec of list) arr.push(rec);
    }
    return arr.sort((a, b) => a.ts - b.ts);
  }

  /** Record (or update) what we know about a loaded source file. */
  registerFile(file: ParsedKey, uncompressedBytes: number, append = false): void {
    const existing = this.files.get(file.key);
    this.files.set(file.key, {
      key: file.key,
      channel: file.channel,
      interval: file.interval,
      host: file.host,
      current: file.current,
      sizeCompressed: file.size || (existing?.sizeCompressed ?? 0),
      sizeUncompressed: append
        ? (existing?.sizeUncompressed ?? 0) + uncompressedBytes
        : uncompressedBytes,
      lastModified: file.lastModified?.getTime() ?? existing?.lastModified,
    });
  }

  /** Remove a file from memory entirely (evict, or a _current finalized away). */
  dropFile(sourceKey: string): void {
    this.files.delete(sourceKey);
    this.replaceFile(sourceKey, []);
  }

  /** Evict several files' records in ONE pass (records filtered once, indexes
   *  rebuilt once) — for memory eviction, where dropping N files individually
   *  would be O(N · records). */
  dropFiles(keys: Set<string>): void {
    if (keys.size === 0) return;
    for (const key of keys) {
      this.files.delete(key);
      this.fileIndexes.delete(key); // its per-kind indexes GC with it
    }
    this.records = this.records.filter((r) => !keys.has(r.sourceKey)); // order preserved → no re-sort
    this.rebuildIndexes();
    this.generation++;
    this.emitData();
  }

  addBatch(batch: Rec[]): void {
    for (const rec of batch) {
      this.records.push(rec);
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
    this.indexBatch(batch);
    this.generation++;
    this.emitData();
  }

  /** Sort once after a scan completes — lines arrive roughly ordered (§3.5). */
  sortByTime(): void {
    this.records.sort((a, b) => a.ts - b.ts);
    this.generation++;
    this.emitData(true); // a scan's final emit must never be throttled away
  }

  /** Append a batch keeping time order (live mode: an append-only tail). */
  appendSorted(batch: Rec[]): void {
    if (batch.length === 0) return;
    for (const rec of batch) {
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
    this.records.push(...batch);
    this.records.sort((a, b) => a.ts - b.ts);
    this.indexBatch(batch);
    this.generation++;
    this.emitData();
  }

  /**
   * Replace every record from one source file (live mode: a re-fetched
   * `_current` snapshot supersedes its previous contents; an empty batch
   * purges a `_current` that was finalized away).
   */
  replaceFile(sourceKey: string, batch: Rec[]): void {
    this.records = this.records.filter((r) => r.sourceKey !== sourceKey);
    this.records.push(...batch);
    this.records.sort((a, b) => a.ts - b.ts);
    this.fileIndexes.delete(sourceKey); // the whole bundle GCs at once
    this.indexBatch(batch);
    this.rebuildIndexes();
    this.generation++;
    this.emitData();
  }

  private rebuildIndexes(): void {
    this.kindCounts.clear();
    this.channelCounts.clear();
    this.levelCounts.clear();
    this.hosts.clear();
    for (const rec of this.records) {
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
  }

  clear(): void {
    this.records = [];
    this.fileIndexes.clear();
    this.kindCache.clear();
    this.kindCounts.clear();
    this.channelCounts.clear();
    this.levelCounts.clear();
    this.hosts.clear();
    this.files.clear();
    this.progress = {
      filesTotal: 0,
      filesDone: 0,
      bytesDone: 0,
      bytesTotal: 0,
      filesFromCache: 0,
      running: false,
    };
    this.generation++;
    this.emitData(true); // emptying views must never be throttled away
    this.dispatchEvent(new Event('progress'));
  }

  private lastEmit = 0;
  private lastEmitCost = 0;

  /**
   * Every store subscriber (the active view, the MEM pill) re-renders
   * synchronously inside this dispatch — timing it measures the incremental
   * UI cost of data landing, the number that degrades as the store grows
   * (#/internals/perf). Sub-millisecond updates aren't worth a log line.
   *
   * While a scan is running, dispatches are adaptively throttled: each must
   * wait at least 5× the cost of the previous one (clamped 1–10 s). Cheap
   * early renders stream per-file; expensive late ones space out instead of
   * freezing the page (perf finding 2026-06-12: unthrottled per-file
   * re-renders of a growing store were 26.8 s of main-thread stalls in a
   * 28 s million-record cold load — O(n²) in disguise). Live-mode appends
   * (progress idle) are never throttled.
   */
  private emitData(force = false): void {
    const now = performance.now();
    if (!force && this.progress.running) {
      const wait = Math.min(10_000, Math.max(1000, this.lastEmitCost * 5));
      if (now - this.lastEmit < wait) return;
    }
    this.lastEmit = now;
    this.dispatchEvent(new Event('data'));
    this.lastEmitCost = performance.now() - now;
    if (this.lastEmitCost >= 1) {
      perf.push({
        ts: Date.now(),
        cat: 'render',
        name: 'store broadcast',
        ms: this.lastEmitCost,
        records: this.records.length,
      });
    }
  }

  setProgress(progress: Partial<ScanProgress>): void {
    this.progress = { ...this.progress, ...progress };
    this.dispatchEvent(new Event('progress'));
  }

  /**
   * Signal that chart-relevant metadata changed (sidecars hydrated in the
   * background) without any record mutation — bump the generation and emit so
   * subscribers re-render and pick up the new sidecars. Throttled like any
   * data emit while a scan is running.
   */
  markChanged(): void {
    this.generation++;
    this.emitData();
  }
}

/**
 * [lo, hi) bounds of a time range in a **ts-sorted** record array, found
 * by binary search: a narrow range over a huge store costs O(log n), not
 * a full scan. Every store-served array (records, kindRecords, merges,
 * transactionsNamed) is ts-sorted, so windows are contiguous runs.
 */
export function rangeBounds(
  records: Rec[],
  range: [number, number] | null | undefined,
): [number, number] {
  if (!range) return [0, records.length];
  // lower bound: first index with ts >= range[0]
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (records[mid].ts < range[0]) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  // upper bound: first index with ts > range[1]
  hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (records[mid].ts <= range[1]) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}

/**
 * The windowed run of a ts-sorted array. Returns the original array when
 * the range is absent or covers everything — no copy on the common path.
 */
export function rangeSlice(
  records: Rec[],
  range: [number, number] | null | undefined,
): Rec[] {
  const [lo, hi] = rangeBounds(records, range);
  return lo === 0 && hi === records.length ? records : records.slice(lo, hi);
}

/** Merge two ts-sorted record arrays into one (events ∪ errors, etc.). */
export function mergeByTime(a: Rec[], b: Rec[]): Rec[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out: Rec[] = new Array<Rec>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i].ts <= b[j].ts ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export const store = new Store();
