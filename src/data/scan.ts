/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import { type ParsedKey, overlapsRange } from '../s3/keys';
import { parseFile } from './parse';
import { cachedDecompressed, storeFetched, type MemBytes } from './blobs';
import { recordFetched, enforceCacheLimit, recordSidecarsBatch, ledgerRecords } from './ledger';
import { INDEXES } from './indexes';
import { SEP } from './cache';
import type { Store } from './store';
import type { Rec } from './types';
import { perf } from './perf';

export const CONCURRENCY = 4;
const SIDECAR_CONCURRENCY = 8;

/**
 * Populate the size ledger with FACTUAL data from finalized files' sidecars
 * (decompressed bytes, record count, hourly histogram), so the memory-limit
 * estimate is exact rather than ratio-based. Only probes files not already
 * checked (sidecarChecked); a 404 marks the file sidecarless so it is never
 * re-probed. Best-effort — a failure just leaves the file to be estimated.
 */
export async function hydrateSidecars(bucket: LogBucket, files: ParsedKey[]): Promise<void> {
  const have = new Map((await ledgerRecords(bucket.bucket)).map((r) => [r.id, r]));
  const need = files.filter(
    (f) => !f.current && !have.get(bucket.bucket + SEP + f.key)?.sidecarChecked,
  );
  if (need.length === 0) return;

  const entries: Parameters<typeof recordSidecarsBatch>[1] = [];
  const queue = [...need];
  async function worker(): Promise<void> {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const meta = await bucket.getSidecar(f.key);
      entries.push({
        key: f.key,
        channel: f.channel,
        interval: f.interval,
        size: f.size,
        etag: f.etag,
        meta,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SIDECAR_CONCURRENCY, need.length) }, () => worker()),
  );
  await recordSidecarsBatch(bucket.bucket, entries);
}

/** Fetch one file's bytes (hot LRU / IndexedDB first), parse it, and time both. */
async function fetchAndParse(
  bucket: LogBucket,
  file: ParsedKey,
  mem: MemBytes,
): Promise<{ result: ReturnType<typeof parseFile>; fromCache: boolean }> {
  const doneFetch = perf.begin('fetch', file.key);
  // finalized files: hot decompressed LRU → IndexedDB (compressed) inflated
  let bytes = file.current ? null : await cachedDecompressed(mem, bucket.bucket, file.key, file.etag);
  const fromCache = bytes !== null;
  if (!bytes) {
    if (file.current) {
      bytes = await bucket.getObjectBytes(file.key); // volatile snapshot, never cached
    } else {
      // pull the stored gzip bytes raw, cache them as-is, inflate for parsing
      bytes = await storeFetched(
        mem,
        bucket.bucket,
        file.key,
        file.etag,
        await bucket.getObjectCompressed(file.key),
      );
    }
  }
  doneFetch({ bytes: bytes.length, cached: fromCache });

  const doneParse = perf.begin('parse', file.key);
  // Finalized files are cached, so their records shed raw lines (rawsource
  // re-reads on demand); _current snapshots have no cache to go back to.
  const result = parseFile(bytes, file, {}, !file.current);
  doneParse({ bytes: result.byteLength, records: result.records.length });
  // ledger: now we know this file's decompressed size, and it was just
  // loaded for display (feeds the per-channel ratio + LRU recency); awaited
  // so the ledger is settled before post-scan cache eviction reads it
  await recordFetched(bucket.bucket, file, result.byteLength, !file.current, Date.now());
  // build + persist every registered aggregate index for finalized (immutable)
  // files, so a later query can be served from one without re-fetching (SPEC
  // §11). Current snapshots change, so we don't index them — they're always
  // loaded fresh. Fire-and-forget; the solver reads these when it can.
  if (!file.current) {
    for (const ix of INDEXES) {
      void ix.persist(bucket.bucket, file.key, file.etag, ix.build(result.records));
    }
  }
  return { result, fromCache };
}

type TimeRange = [number, number] | null;

/** One file's loaded result — decompressed records + their byte size. */
export interface LoadedFile {
  records: Rec[];
  byteLength: number;
  fromCache: boolean;
}

/**
 * Fetch + parse + cache one file. Injectable so the working-set orchestration
 * can be tested deterministically without S3 / IndexedDB; production uses the
 * default (fetchAndParse), which caches both byte tiers as the bytes land.
 */
export type FileLoader = (file: ParsedKey) => Promise<LoadedFile>;

/**
 * The working-set loader (SPEC §7). A *working set* is the set of files implied
 * by the current selection — the active channels × the selected time-range —
 * optionally narrowed by a focused range. The controller continuously pursues
 * that set, a few files at a time, appending records as each lands.
 *
 * It is re-scopable: when the range changes, `resync()` recomputes the
 * working set and re-pumps. Files no longer in the set are simply never picked
 * (their *pending* loads are cancelled), while in-flight fetches finish and are
 * kept — nothing already loaded is evicted. A channel/range change is a *new
 * plan*: `reset(plan)` clears and reloads from scratch. The load denominator
 * (progress.bytesTotal) tracks the working set, so it shrinks as you narrow the range.
 */
export class LoadController {
  private plan: ParsedKey[] = [];
  private ws: ParsedKey[] = []; // cached working set (plan ∩ range)
  private inFlight = new Set<string>();
  private active = 0;
  private cached = 0; // cumulative cache hits, for the scan detail
  private failed?: string;
  private epoch = 0; // bumped on reset; stale in-flight results are discarded
  private dirty = false; // records added since the last sort
  private doneScan: ((info: Record<string, unknown>) => void) | null = null;
  private loadFile: FileLoader;

  constructor(
    private store: Store,
    private bucket: LogBucket,
    private mem: MemBytes,
    private cacheLimitBytes: number | null,
    private getRange: () => TimeRange,
    loadFile?: FileLoader,
  ) {
    this.loadFile =
      loadFile ??
      ((file) =>
        fetchAndParse(this.bucket, file, this.mem).then(({ result, fromCache }) => ({
          records: result.records,
          byteLength: result.byteLength,
          fromCache,
        })));
  }

  /** New plan (channel/range change): drop the old working set and reload. */
  reset(plan: ParsedKey[]): void {
    this.epoch++; // in-flight loads from the old plan will be discarded on land
    this.plan = plan;
    this.cached = 0;
    this.failed = undefined;
    this.dirty = false;
    // a new plan replaces the *displayed* working set, so clear the record store
    // — but NOT the byte cache: any completed download stays cached (hot LRU +
    // IndexedDB), bounded only by the LRU/limit, so it is never wasted and a
    // flip back to a prior selection re-parses straight from memory
    this.store.clear();
    this.doneScan = perf.begin('scan', `scan s3://${this.bucket.bucket}`);
    this.resync();
  }

  /**
   * Range changed, or a load finished: recompute the working set,
   * update progress, and pump workers toward its unloaded files. Out-of-set
   * pending files are never picked; in-flight ones finish and are kept.
   */
  resync(): void {
    const w = this.getRange();
    this.ws = w ? this.plan.filter((f) => overlapsRange(f, w[0], w[1])) : this.plan;
    this.updateProgress();
    this.pump();
  }

  /** Keys of the files this loader intends to load (its plan). When the plan is
   *  a memory-clamped subset of the selection, the selection's other files are
   *  budget-refused — their intervals get the persistent ghost band (SPEC §7). */
  planKeySet(): Set<string> {
    return new Set(this.plan.map((f) => f.key));
  }

  private nextPending(): ParsedKey | null {
    // the plan is newest-first, so the first unloaded match is the newest one —
    // and within a multi-interval range this naturally favours its covering files
    for (const f of this.ws) {
      if (!this.store.files.has(f.key) && !this.inFlight.has(f.key)) return f;
    }
    return null;
  }

  private pump(): void {
    while (this.active < CONCURRENCY && !this.failed) {
      const file = this.nextPending();
      if (!file) break;
      this.active++;
      this.inFlight.add(file.key);
      void this.loadOne(file, this.epoch);
    }
    if (this.active === 0) this.settle();
  }

  private async loadOne(file: ParsedKey, epoch: number): Promise<void> {
    try {
      // Finalized files are immutable: ETag-checked cache hits skip S3 entirely
      // (SPEC §8). _current snapshots are never cached. The fetch caches the
      // bytes as they land, so a completed download is never wasted even if the
      // epoch moved on (new plan) and we discard its records here.
      const { records, byteLength, fromCache } = await this.loadFile(file);
      if (epoch === this.epoch) {
        this.store.registerFile(file, byteLength);
        this.store.addBatch(records);
        if (fromCache) this.cached++;
        this.dirty = true;
      }
    } catch (err) {
      if (epoch === this.epoch) this.failed = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(file.key);
      this.active--;
      if (this.cacheLimitBytes != null) {
        try {
          await enforceCacheLimit(this.bucket.bucket, this.cacheLimitBytes);
        } catch {
          /* eviction is best-effort */
        }
      }
      this.updateProgress();
      this.pump();
    }
  }

  /** The working set has drained: a final time-sort + a settled progress emit. */
  private settle(): void {
    if (this.dirty) {
      this.dirty = false;
      this.store.sortByTime(); // lines arrive roughly ordered; one sort at rest
    }
    this.updateProgress();
    if (this.doneScan) {
      this.doneScan({
        detail: `${this.ws.length} files (${this.cached} cached)` + (this.failed ? ` — failed: ${this.failed}` : ''),
        records: this.store.records.length,
      });
      this.doneScan = null;
    }
  }

  /** Recompute the working-set progress (filesDone/bytes are absolute, not cumulative). */
  private updateProgress(): void {
    let bytesTotal = 0;
    let bytesDone = 0;
    let filesDone = 0;
    for (const f of this.ws) {
      bytesTotal += f.size;
      if (this.store.files.has(f.key)) {
        filesDone++;
        bytesDone += f.size;
      }
    }
    this.store.setProgress({
      filesTotal: this.ws.length,
      filesDone,
      bytesDone,
      bytesTotal,
      filesFromCache: this.cached,
      // a failure stops the loader — don't report "running" for files it will
      // never pick up (they're unloaded, but the scan has halted)
      running: !this.failed && (this.active > 0 || this.nextPending() !== null),
      error: this.failed,
    });
  }
}

/** Load one file into the store (inspector "load" action) — cache-aware. */
export async function loadOneFile(
  store: Store,
  bucket: LogBucket,
  file: ParsedKey,
  cacheLimitBytes: number | null,
  mem: MemBytes,
): Promise<void> {
  const { result } = await fetchAndParse(bucket, file, mem);
  store.registerFile(file, result.byteLength);
  store.replaceFile(file.key, result.records);
  if (cacheLimitBytes != null) await enforceCacheLimit(bucket.bucket, cacheLimitBytes);
}
