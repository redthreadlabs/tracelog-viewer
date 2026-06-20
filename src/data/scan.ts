/**
 * Scan execution: materialize a ScanPlan into the store, a few files at a
 * time, appending records as each file lands (stream-render, SPEC §7).
 */
import type { LogBucket } from '../s3/client';
import { type ParsedKey, overlapsRange } from '../s3/keys';
import { parseFile, parseFileStreaming, type ParseResult } from './parse';
import { gzip, isGzip } from './gzip';
import { recordFetched, enforceCacheLimit, recordSidecarsBatch, ledgerRecords } from './ledger';
import { INDEXES } from './indexes';
import { buildLocatorIndex, putOriginIndex } from './originindex';
import { SEP, cacheGet, cachePut } from './cache';
import type { Store } from './store';
import type { Origin, Rec } from './types';
import { perf } from './perf';

export const CONCURRENCY = 4;
/** in-flight cap for a background prefetch — half, to stay out of the way */
const PREFETCH_CONCURRENCY = 2;
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

/** Fetch one file's bytes, parse it, and time both. Finalized files stay
 *  compressed end-to-end — the gz comes from the IndexedDB cache (or S3) and is
 *  parsed by a STREAMING inflate, so the decompressed body is never held in
 *  memory (SPEC §8). Volatile `_current` snapshots arrive already inflated. */
async function fetchAndParse(
  bucket: LogBucket,
  file: ParsedKey,
): Promise<{ result: ParseResult; fromCache: boolean }> {
  const doneFetch = perf.begin('fetch', file.key);
  let result: ParseResult;
  let fromCache: boolean;
  if (file.current) {
    // volatile snapshot — fetched already inflated, never cached; keep raw lines
    const bytes = await bucket.getObjectBytes(file.key);
    fromCache = false;
    doneFetch({ bytes: bytes.length, cached: false });
    const doneParse = perf.begin('parse', file.key);
    result = parseFile(bytes, file, {}, false);
    doneParse({ bytes: result.byteLength, records: result.records.length });
  } else {
    // finalized + immutable: gz from the cache, else S3; keep the disk tier
    // compressed, then stream-parse it (shedding raw lines — re-read on demand)
    let gz = await cacheGet(bucket.bucket, file.key, file.etag);
    fromCache = gz !== null;
    if (!gz) {
      const fetched = await bucket.getObjectCompressed(file.key);
      gz = isGzip(fetched) ? fetched : await gzip(fetched);
      if (file.etag) {
        try {
          await cachePut(bucket.bucket, file.key, file.etag, gz);
        } catch {
          /* storage unavailable — degrade to network on the next read */
        }
      }
    }
    doneFetch({ bytes: gz.length, cached: fromCache });
    const doneParse = perf.begin('parse', file.key);
    result = await parseFileStreaming(gz, file, {}, true);
    doneParse({ bytes: result.byteLength, records: result.records.length });
  }
  // ledger: now we know this file's decompressed size, and it was just
  // loaded for display (feeds the per-channel ratio + LRU recency); awaited
  // so the ledger is settled before post-scan cache eviction reads it
  await recordFetched(bucket.bucket, file, result.byteLength, !file.current, Date.now());
  // build + persist every registered aggregate index for finalized (immutable)
  // files, so a later query can be served from one without re-fetching (SPEC
  // §11). Current snapshots change, so we don't PERSIST an index for them —
  // they're always loaded fresh, and the solver builds their index in memory on
  // demand instead (backend.ts `filePayload`), so the _current interval is never
  // dropped from a query. Fire-and-forget; the solver reads these when it can.
  if (!file.current) {
    for (const ix of INDEXES) {
      void ix.persist(bucket.bucket, file.key, file.etag, ix.build(result.records));
    }
    // The point-lookup origin index: lifetime_id → line, built from the file's
    // origin metadata lines (not records). Lets a later, window-disjoint scan
    // resolve a client's device/os/app version by hopping back to this file.
    if (result.originLines.length > 0) {
      void putOriginIndex(bucket.bucket, file.key, file.etag, buildLocatorIndex(result.originLines));
    }
  }
  return { result, fromCache };
}

type TimeRange = [number, number] | null;

/** One file's loaded result — decompressed records + their byte size. */
export interface LoadedFile {
  records: Rec[];
  /** in-stream client origins (metadata records keyed by lifetime_id) */
  origins: Origin[];
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
  /** per-file recency: a monotonic tick set each time the file is in the working
   *  set, so eviction can pick the least-recently-in-set out-of-set file first */
  private recency = new Map<string, number>();
  private tick = 0;
  private inFlight = new Set<string>();
  private active = 0;
  private cached = 0; // cumulative cache hits, for the scan detail
  private failed?: string;
  private epoch = 0; // bumped on reset; stale in-flight results are discarded
  private dirty = false; // records added since the last sort
  /** in-flight cap. Lowered while this load is a BACKGROUND prefetch (a view that
   *  doesn't need the records yet), so it doesn't saturate IO or starve the
   *  index queries the overview is running on the same thread; restored to full
   *  the moment a view actually waits on the records (SPEC §8/§11). */
  private concurrency = CONCURRENCY;
  private doneScan: ((info: Record<string, unknown>) => void) | null = null;
  private loadFile: FileLoader;

  constructor(
    private store: Store,
    private bucket: LogBucket,
    private cacheLimitBytes: number | null,
    private memoryLimitBytes: number | null,
    private getRange: () => TimeRange,
    loadFile?: FileLoader,
  ) {
    this.loadFile =
      loadFile ??
      ((file) =>
        fetchAndParse(this.bucket, file).then(({ result, fromCache }) => ({
          records: result.records,
          origins: result.origins,
          byteLength: result.byteLength,
          fromCache,
        })));
  }

  /** Unconditional wipe + reload (a clear/deselect). */
  reset(plan: ParsedKey[]): void {
    this.epoch++; // in-flight loads from the old plan will be discarded on land
    this.plan = plan;
    this.cached = 0;
    this.failed = undefined;
    this.dirty = false;
    // the displayed working set is replaced, so clear the record store — but NOT
    // the byte cache: a completed download stays cached (IndexedDB), so a flip
    // back to a prior selection re-parses from there rather than re-downloading
    this.store.clear();
    this.doneScan = perf.begin('scan', `scan s3://${this.bucket.bucket}`);
    this.resync();
  }

  /**
   * Set the plan for the active selection — PURELY ADDITIVE (SPEC §8). The
   * selection (channels × hosts × range) is a *view* over the loaded data, so
   * changing it never evicts: we keep every parsed record (re-selecting is
   * instant, no re-parse), fetch only the new plan's not-yet-loaded files, and
   * drop only the now-out-of-plan PENDING fetches (in-flight ones finish, kept).
   * The solver scopes each query to the selection (currentPlan), so a deselected
   * channel/host simply stops appearing — its records aren't wiped. The store is
   * bounded by the eviction pass (memory limit) ALONE. Genuine wipes — clearStore,
   * profile switch, deselect-all — go through `reset`, not here.
   */
  setPlan(files: ParsedKey[]): void {
    this.plan = files;
    this.failed = undefined;
    this.doneScan ??= perf.begin('scan', `scan s3://${this.bucket.bucket}`);
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
    for (const f of this.ws) this.recency.set(f.key, ++this.tick); // freshen in-set files
    this.updateProgress();
    this.pump();
  }

  /**
   * Bound the record store under the memory limit (SPEC §8). A file's COMPRESSED
   * (gzip) size proxies its record footprint: `Rec` interns low-cardinality
   * fields, so heap tracks the entropy gzip already collapses better than
   * decompressed size does — and compressed size is exact + free from the listing
   * (we can't measure the JS heap; see MEMORY_MANAGEMENT_GOTCHAS.md). When the
   * resident total exceeds the limit, evict OUT-OF-working-set files only — least-
   * recently-in-set first, then biggest — never one the views are showing. (If
   * the working set itself exceeds the limit, that's the load clamp's job.)
   */
  private evictRecords(): void {
    if (this.memoryLimitBytes == null) return;
    let total = 0;
    for (const f of this.store.files.values()) total += f.sizeCompressed;
    if (total <= this.memoryLimitBytes) return;
    const wsKeys = new Set(this.ws.map((f) => f.key));
    const victims = [...this.store.files.values()]
      .filter((f) => !wsKeys.has(f.key))
      .sort(
        (a, b) =>
          (this.recency.get(a.key) ?? 0) - (this.recency.get(b.key) ?? 0) ||
          b.sizeCompressed - a.sizeCompressed,
      );
    const drop = new Set<string>();
    for (const f of victims) {
      if (total <= this.memoryLimitBytes) break;
      drop.add(f.key);
      this.recency.delete(f.key);
      total -= f.sizeCompressed;
    }
    this.store.dropFiles(drop);
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

  /** Set the load priority: background (throttled prefetch) vs foreground (a view
   *  is waiting). Raising it pumps more workers immediately. */
  setBackground(background: boolean): void {
    this.concurrency = background ? PREFETCH_CONCURRENCY : CONCURRENCY;
    if (!background) this.pump(); // un-throttle: fill the freed slots now
  }

  private pump(): void {
    while (this.active < this.concurrency && !this.failed) {
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
      const { records, origins, byteLength, fromCache } = await this.loadFile(file);
      if (epoch === this.epoch) {
        this.store.registerFile(file, byteLength);
        this.store.registerOrigins(origins); // before addBatch: same-file enrich
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
      this.evictRecords(); // bound the record store (compressed-size proxy)
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

  /** Recompute the working-set progress in COMPRESSED bytes (the listing size —
   *  the memory-budget currency); filesDone/bytes are absolute, not cumulative. */
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
): Promise<void> {
  const { result } = await fetchAndParse(bucket, file);
  store.registerFile(file, result.byteLength);
  store.registerOrigins(result.origins);
  store.replaceFile(file.key, result.records);
  if (cacheLimitBytes != null) await enforceCacheLimit(bucket.bucket, cacheLimitBytes);
}
