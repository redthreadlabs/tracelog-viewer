/**
 * The store backend (SPEC §5, §8): scan, parse, cache I/O, live mode, and
 * the record store itself run here — inside a SharedWorker when available,
 * so every tab on the same profile shares ONE working set, one fetch
 * pipeline, and one IndexedDB writer; parse and its GC churn never touch a
 * tab's main thread. Sessions are keyed by profile signature (bucket +
 * region + access key): tabs on different buckets get separate sessions.
 *
 * Tabs are thin clients (data/storeclient.ts): request/response ops over
 * postMessage, store events relayed as broadcasts. Results that could be
 * huge are SAMPLED OR CAPPED AT THIS BOUNDARY — a structured clone never
 * carries an unbounded array; whatever is sampled says so in its result
 * (`sample: {drawn, total, okStep}`), the same disclosure contract as the
 * scatter pill.
 */
import { Store, mergeByTime, rangeSlice } from '../data/store';
import type { FileInfo, ScanProgress } from '../data/store';
import { LogBucket } from '../s3/client';
import type { Profile } from '../ui/profiles';
import { planScan, type ScanPlan } from '../s3/scanner';
import { LoadController, loadOneFile, hydrateSidecars } from '../data/scan';
import { LiveUpdater } from '../data/live';
import { perf, type PerfEntry } from '../data/perf';
import { cacheKeys, cacheWipeBucket, cacheGetAny, cachePut, SEP } from '../data/cache';
import { gunzipLineN, isGzip } from '../data/gzip';
import { parseKey, dedupeCurrents, overlapsRange, intervalSpan, type ParsedKey } from '../s3/keys';
import { nthLine } from '../data/parse';
import {
  originIndexRecords,
  originIndexStats,
  resolveOrigin,
  type OriginResolverDeps,
} from '../data/originindex';
import type { Origin, Rec, RecordKind } from '../data/types';
import type { RecordOrigin } from '@redthreadlabs/tracelog-schema';
import {
  aggregateBySeries,
  blankPartialSeries,
  periodGrid,
  resolvePeriodMs,
  logHistogram,
  groupTransactions,
  transactionStats,
  resultFamily,
  type SeriesResult,
  type WeightedPoint,
  type TxnGroup,
} from '../data/aggregate';
import {
  matchIndex,
  INDEXES,
  txnIndex,
  durHistIndex,
  type AggregateIndex,
  type StoredIndex,
} from '../data/indexes';
import { mergeRangeBins, quantileFromBins, binValue, type Bins, type DurHistFileIndex } from '../data/durhist';
import { mergeRangeTotals, type TxnTotals, type TxnFileIndex } from '../data/txnindex';
import { planIndexBatch, type MetricSpec } from '../data/planner';
import { assembleTrace } from '../data/trace';
import { deploymentMarkers, runtimeSeries, breakdownSelfTime } from '../data/metrics';
import {
  clientProfiles,
  appVersions,
  slowClientEvents,
  clientEventTypes,
} from '../data/clients';
import { scannerStats } from '../data/scanner-traffic';
import { recordListing, ledgerRecords } from '../data/ledger';
import type { Metric } from './query';

type TimeRange = [number, number] | null;

/** what every tab can read synchronously between events */
export interface Snapshot {
  generation: number;
  recordCount: number;
  kindCounts: Map<RecordKind, number>;
  channelCounts: Map<string, number>;
  hosts: string[];
  files: FileInfo[];
  progress: ScanProgress;
}

export interface SampleNote {
  drawn: number;
  total: number;
  okStep: number;
}

export interface Request {
  id: number;
  op: string;
  args: Record<string, unknown>;
}

export type Outbound =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { ev: 'data' | 'progress'; snapshot: Snapshot }
  | { ev: 'perf'; entry: PerfEntry }
  // a deferred result (SPEC §11): a plan returns its index-served parts at once
  // and a `token`; the scan-served part streams back here as the load fills in,
  // `done` on the last push. Bounded results only — raw records never cross.
  | { deferred: string; result: unknown; done: boolean };

interface PortLike {
  postMessage(message: unknown): void;
}

/** the scatter's point budget, applied where the clone happens */
const MAX_INSTANCES = 20_000;
const MAX_SLOW_EVENTS = 500;

/** How many prior existing intervals the origin hop walks back (SPEC §6.6). A
 *  launch's origin is temporally near its records; sessions rarely stay hot for
 *  many consecutive intervals, so a few hops find it (a miss is normal). */
const ORIGIN_MAX_HOPS = 6;

/** Map a resolved RecordOrigin to the viewer's display Origin (lifetimeId is the
 *  key we searched for; service.version = app version, device.model = device,
 *  os = "name version"). Mirrors parse.ts `extractOrigin`. */
function viewerOrigin(lifetimeId: string, ro: RecordOrigin): Origin {
  const os = ro.os;
  return {
    lifetimeId,
    appVersion: ro.service?.version,
    device: ro.device?.model,
    deviceId: ro.device?.id,
    os: os?.name ? (os.version ? `${os.name} ${os.version}` : os.name) : undefined,
  };
}

/** MB → bytes, or null when no limit is set. */
function mbToBytes(mb: number | undefined): number | null {
  return mb != null && mb > 0 ? mb * 1024 * 1024 : null;
}

class Session {
  store = new Store();
  bucket: LogBucket;
  live: LiveUpdater;
  liveChannels: string[] = [];
  /** hosts the live updater actively watches (null = all) — the manual subset,
   *  or the resolved live set in "all current" mode (SPEC §6.0) */
  liveHostFilter: string[] | null = null;
  /** the two independent demands for live: the scanbar (derived from the view's
   *  range), and the store inspector (which demands the latest intervals stay
   *  live while it's open). The updater runs if EITHER wants it. */
  scanbarLive = false;
  inspectorLive = false;
  ports = new Set<PortLike>();
  lastUsed = Date.now();
  cacheLimitBytes: number | null;
  /** the current selection's files (set by planScan) — the FULL selection, used
   *  by metadata-served charts (may exceed what the loader is loading if the
   *  load was clamped to a memory budget) */
  currentPlan: ParsedKey[] = [];
  /** the user's focused time range (brush) — narrows the loader's working set
   *  so a zoom loads (and reports progress for) only its covering files */
  currentRange: TimeRange = null;
  /** the working-set loader — re-scoped on range change, reset on new plan */
  loader: LoadController;
  /** loaded aggregate-index maps, cached by store generation (SPEC §11). The
   *  index-only overview reads each index from IndexedDB once; every subsequent
   *  toggle/zoom reuses the parsed map. A parse bumps the generation (it rebuilds
   *  indexes), which invalidates this — so it can never go stale. */
  private indexCache: { gen: number; maps: Map<string, Map<string, StoredIndex<unknown>>> } | null =
    null;
  constructor(profile: Profile) {
    this.bucket = new LogBucket(profile);
    this.cacheLimitBytes = mbToBytes(profile.cacheLimitMb);
    this.loader = new LoadController(
      this.store,
      this.bucket,
      this.cacheLimitBytes,
      mbToBytes(profile.memoryLimitMb), // bounds the record store (eviction)
      () => this.currentRange,
    );
    this.live = new LiveUpdater(
      this.store,
      this.bucket,
      () => this.liveChannels,
      () => this.liveHostFilter,
    );
    this.store.addEventListener('data', () => {
      this.broadcast('data');
      void this.fireDeferred();
      void this.maybeResolveOrigins();
    });
    this.store.addEventListener('progress', () => {
      this.broadcast('progress');
      void this.fireDeferred();
    });
  }

  /** Run the live updater if EITHER the scanbar or the store inspector wants it;
   *  start() re-discovers with the latest channels/host-filter, so a fresh demand
   *  (or a selection change) takes effect immediately. */
  applyLive(): void {
    if (this.scanbarLive || this.inspectorLive) this.live.start();
    else this.live.stop();
  }

  // ---- deferred results (SPEC §11): a producer recomputes a bounded result as
  // the working-set load streams in, pushed to the tab under a token until the
  // load settles. Empty when no view is awaiting one, so it costs nothing then.
  private deferredSeq = 0;
  private deferred = new Map<string, { produce: () => Promise<unknown> | unknown; lastGen: number }>();

  /** Register a deferred producer; returns its token. Recomputed + pushed on
   *  each record change (and once when the load settles). */
  addDeferred(produce: () => Promise<unknown> | unknown): string {
    const token = `d${++this.deferredSeq}`;
    this.deferred.set(token, { produce, lastGen: this.store.generation });
    return token;
  }
  cancelDeferred(token: string): void {
    this.deferred.delete(token);
  }
  private async fireDeferred(): Promise<void> {
    if (this.deferred.size === 0) return;
    const done = !this.store.progress.running;
    const gen = this.store.generation;
    for (const [token, d] of this.deferred) {
      if (d.lastGen === gen && !done) continue; // no new records, not the final tick
      d.lastGen = gen;
      const result = await d.produce();
      const message: Outbound = { deferred: token, result, done };
      for (const port of this.ports) port.postMessage(message);
      if (done) this.deferred.delete(token); // last push — retire it
    }
  }

  /** A registered index's loaded payloads, by file id — cached for the current
   *  store generation (see `indexCache`). */
  async loadIndex<P>(ix: AggregateIndex<P>): Promise<Map<string, StoredIndex<P>>> {
    const gen = this.store.generation;
    if (!this.indexCache || this.indexCache.gen !== gen) {
      this.indexCache = { gen, maps: new Map() };
    }
    let m = this.indexCache.maps.get(ix.name);
    if (!m) {
      m = (await ix.load(this.bucket.bucket)) as Map<string, StoredIndex<unknown>>;
      this.indexCache.maps.set(ix.name, m);
    }
    return m as Map<string, StoredIndex<P>>;
  }

  /** Drop the cached index maps — for when the stored indexes change without a
   *  store-generation bump (a cache wipe deletes them out from under us). */
  clearIndexCache(): void {
    this.indexCache = null;
  }

  snapshot(): Snapshot {
    return {
      generation: this.store.generation,
      recordCount: this.store.records.length,
      kindCounts: this.store.kindCounts,
      channelCounts: this.store.channelCounts,
      hosts: [...this.store.hosts],
      files: [...this.store.files.values()],
      progress: this.store.progress,
    };
  }

  broadcast(ev: 'data' | 'progress'): void {
    const message: Outbound = { ev, snapshot: this.snapshot() };
    for (const port of this.ports) port.postMessage(message);
  }

  // ---- selection scoping ----
  // The selection (channels × hosts, in `currentPlan`) is a VIEW over the loaded
  // store: a record-iterating query must see only the selected channel/host pairs,
  // exactly as the index path does via `currentPlan.filter(...)`. This is why a
  // deselected channel/host stops appearing WITHOUT being evicted — the store is
  // bounded by the memory limit alone, never by a selection change. (Range scoping
  // stays each query's `rangeSlice`; a distributed trace is exempt — it's one
  // cross-channel unit.)
  private inSelection(): (r: Rec) => boolean {
    const sel = new Set(this.currentPlan.map((f) => `${f.channel} ${f.host}`));
    return (r) => sel.has(`${r.channel} ${r.host}`);
  }
  /** All loaded records, scoped to the selected channel/host set. */
  selectedRecords(): Rec[] {
    return this.store.records.filter(this.inSelection());
  }
  /** Loaded records of one kind, scoped to the selection. */
  selectedKind(kind: RecordKind): Rec[] {
    return this.store.kindRecords(kind).filter(this.inSelection());
  }
  /** A transaction's loaded instances, scoped to the selection. */
  selectedNamed(name: string): Rec[] {
    return this.store.transactionsNamed(name).filter(this.inSelection());
  }

  // ---- origin resolution (SPEC §6.6): the point-lookup origin index ----
  // A client lifetime emits its RecordOrigin once at launch; a window that
  // excludes that interval has records with a lifetime_id but no origin in view.
  // After a load settles, resolve those by hopping back over the channel's
  // previously-indexed files (data/originindex.ts) and reading the located line.

  private resolvingOrigins = false;
  /** lifetimes already hop-attempted (resolved OR a normal miss), so a miss isn't
   *  re-hopped on every settle. Reset when the indexed-file set grows, since new
   *  origin indexes may make a prior miss resolvable. */
  private originAttempted = new Set<string>();
  private originIndexCountAtAttempt = -1;

  /** Read line `line` of a finalized file and parse its `{metadata: RecordOrigin}`
   *  body. Fetch-on-evict: the origin INDEX outlives the byte cache, so if the
   *  bytes were evicted we re-fetch the (immutable) file and re-cache it — a
   *  targeted retrieval, since the index told us exactly where the origin is. */
  private async readOriginLine(file: ParsedKey, line: number): Promise<RecordOrigin | null> {
    let bytes = await cacheGetAny(this.bucket.bucket, file.key);
    if (!bytes) {
      try {
        bytes = await this.bucket.getObjectCompressed(file.key);
      } catch {
        return null;
      }
      if (bytes && file.etag) void cachePut(this.bucket.bucket, file.key, file.etag, bytes);
    }
    if (!bytes) return null;
    const raw = isGzip(bytes)
      ? await gunzipLineN(bytes, line)
      : nthLine(new TextDecoder().decode(bytes), line);
    if (!raw) return null;
    try {
      const md = (JSON.parse(raw) as { metadata?: unknown }).metadata;
      return md && typeof md === 'object' ? (md as RecordOrigin) : null;
    } catch {
      return null;
    }
  }

  /** Once a load settles, hop-resolve any loaded records whose origin is outside
   *  the window. Re-entrancy-guarded; only touches not-yet-attempted lifetimes. */
  private async maybeResolveOrigins(): Promise<void> {
    if (this.resolvingOrigins || this.store.progress.running) return;
    const unresolved = this.store.unresolvedOrigins();
    if (unresolved.size === 0) return;

    this.resolvingOrigins = true;
    try {
      const indexes = await originIndexRecords(this.bucket.bucket);
      // The indexed-file set grew → new origins may now be reachable, so re-attempt
      // prior misses (this also bounds `originAttempted`'s growth).
      if (indexes.size !== this.originIndexCountAtAttempt) {
        this.originAttempted.clear();
        this.originIndexCountAtAttempt = indexes.size;
      }
      const todo = [...unresolved].filter(([lid]) => !this.originAttempted.has(lid));
      if (todo.length === 0 || indexes.size === 0) {
        for (const [lid] of todo) this.originAttempted.add(lid);
        return;
      }
      // Candidate files come from the index keys (the previously-scanned set) —
      // no S3 listing needed — grouped by channel for the per-lifetime hop.
      const byChannel = new Map<string, ParsedKey[]>();
      for (const id of indexes.keys()) {
        const pk = parseKey(id.slice(id.indexOf(SEP) + 1));
        if (!pk) continue;
        let list = byChannel.get(pk.channel);
        if (!list) byChannel.set(pk.channel, (list = []));
        list.push(pk);
      }
      const deps: OriginResolverDeps = {
        loadIndex: (f) => Promise.resolve(indexes.get(this.bucket.bucket + SEP + f.key)?.index ?? null),
        readOriginLine: (f, line) => this.readOriginLine(f, line),
      };

      const resolved: Origin[] = [];
      for (const [lid, where] of todo) {
        this.originAttempted.add(lid); // attempted (resolved or normal miss)
        const from = parseKey(where.sourceKey);
        const files = byChannel.get(where.channel);
        if (!from || !files) continue;
        const ro = await resolveOrigin(lid, from.interval, files, ORIGIN_MAX_HOPS, deps);
        if (ro) resolved.push(viewerOrigin(lid, ro));
      }
      // back-fills the records + emits 'data' (which re-fires this — but the now
      // resolved/attempted lifetimes are all skipped, so it settles immediately).
      if (resolved.length > 0) this.store.registerOrigins(resolved);
    } finally {
      this.resolvingOrigins = false;
    }
  }

}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 4;

function profileSignature(p: Profile): string {
  return `${p.bucket}|${p.region}|${p.accessKeyId}`;
}

function getSession(profile: Profile): Session {
  const key = profileSignature(profile);
  let session = sessions.get(key);
  if (!session) {
    // bound total worker memory: drop the longest-idle session
    if (sessions.size >= MAX_SESSIONS) {
      let oldest: [string, Session] | null = null;
      for (const e of sessions) {
        if (!oldest || e[1].lastUsed < oldest[1].lastUsed) oldest = e;
      }
      if (oldest) {
        oldest[1].live.stop();
        sessions.delete(oldest[0]);
      }
    }
    session = new Session(profile);
    sessions.set(key, session);
  }
  session.lastUsed = Date.now();
  return session;
}

// worker-side perf entries (fetch/parse/scan/live) stream to every tab
const allPorts = new Set<PortLike>();
perf.addEventListener('entry', () => {
  const entry = perf.entries[perf.entries.length - 1];
  if (!entry) return;
  const message: Outbound = { ev: 'perf', entry };
  for (const port of allPorts) port.postMessage(message);
});

/** Sample a txn's instances at the boundary: every problem, strided ok. */
function sampleInstances(instances: Rec[]): { rows: Rec[]; sample?: SampleNote } {
  if (instances.length <= MAX_INSTANCES) return { rows: instances };
  const ok: Rec[] = [];
  const problems: Rec[] = [];
  for (const r of instances) (resultFamily(r) === 'ok' ? ok : problems).push(r);
  const budget = Math.max(2000, MAX_INSTANCES - problems.length);
  const okStep = Math.ceil(ok.length / budget);
  const rows: Rec[] = [];
  for (let i = 0; i < ok.length; i += okStep) rows.push(ok[i]);
  rows.push(...problems);
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, sample: { drawn: rows.length, total: instances.length, okStep } };
}

/**
 * The time spans of intervals in the selection (currentPlan) whose files aren't
 * ALL accounted for yet — used to blank partially-covered periods, so an
 * interval is either fully populated or left blank, never partial. A file is
 * "accounted" if its records are loaded OR an index covers it (`covered`).
 */
function incompleteSpans(s: Session, covered: Set<string> = new Set()): [number, number][] {
  const byInterval = new Map<string, { total: number; have: number }>();
  for (const f of s.currentPlan) {
    const e = byInterval.get(f.interval) ?? { total: 0, have: 0 };
    e.total++;
    if (s.store.files.has(f.key) || covered.has(f.key)) e.have++;
    byInterval.set(f.interval, e);
  }
  const spans: [number, number][] = [];
  for (const [interval, { total, have }] of byInterval) {
    if (have < total) {
      const span = intervalSpan(interval);
      if (span) spans.push(span);
    }
  }
  return spans;
}

/** [earliest interval start, latest interval end] across the whole selection. */
function operatingRange(s: Session): [number, number] {
  let lo = Infinity;
  let hi = 0;
  for (const f of s.currentPlan) {
    const span = intervalSpan(f.interval);
    if (!span) continue;
    if (span[0] < lo) lo = span[0];
    if (span[1] > hi) hi = span[1];
  }
  return [lo, hi];
}

/**
 * Spans of intervals the memory budget refused — in the selection (currentPlan)
 * but clamped out of what the loader will load, so their records will never
 * arrive. They have metadata (still in currentPlan, so sidecars hydrate), hence
 * the *persistent* ghost flavor: accurate bars + ghost background (SPEC §7).
 * Empty when within budget (the loader plan equals the selection) or when no
 * scan is loading yet (so transitions don't flash an all-refused chart). A
 * refused file that an index `covered` is NOT a ghost — its bar is accurate.
 */
function budgetRefusedSpans(s: Session, covered: Set<string> = new Set()): [number, number][] {
  const loaded = s.loader.planKeySet();
  if (loaded.size === 0) return [];
  const refused = new Set<string>();
  for (const f of s.currentPlan) {
    if (!loaded.has(f.key) && !covered.has(f.key)) refused.add(f.interval);
  }
  const spans: [number, number][] = [];
  for (const interval of refused) {
    const span = intervalSpan(interval);
    if (span) spans.push(span);
  }
  return spans;
}

/** Clip spans to [lo, hi], drop empties, and merge overlapping/adjacent ones. */
function mergeSpans(spans: [number, number][], lo: number, hi: number): [number, number][] {
  const clipped = spans
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of clipped) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** How many transactions the overview stacks before folding the tail into
 *  "Other" — the readable ceiling for a stacked bar (SPEC §11.5). */
const SERIES_TOP_N = 8;

/**
 * Gather index contributions for a query (SPEC §11, the matcher). The registry
 * (`matchIndex`) decides whether a registered index can satisfy the metric at
 * this grid; if so, files contribute their rollups as weighted points.
 *
 * Two regimes, chosen by coverage:
 *  - **index-only** (`indexOnly: true`): when EVERY in-range file has a valid
 *    stored payload, serve them all from the index and scan nothing — the
 *    fastest plan (SPEC §11.5). The caller passes no records, so this is instant
 *    regardless of what's loaded in memory. This is the overview's common case.
 *  - **mixed** (`indexOnly: false`): otherwise, only files that are NOT loaded
 *    and lie FULLY inside the range are index-served (disjoint from the record
 *    read, no double count); the rest are records-served. The fallback for cold
 *    ranges, sub-hour grids, or a file whose index is missing/stale.
 */
async function indexContributions(
  s: Session,
  range: [number, number],
  metric: Metric,
  showSet: Set<string> | undefined,
  periodMs: number | null,
  utc: boolean,
): Promise<{ extra: WeightedPoint[]; covered: Set<string>; indexOnly: boolean }> {
  const empty = { extra: [] as WeightedPoint[], covered: new Set<string>(), indexOnly: false };
  const grid = periodGrid(range[0], range[1], range, periodMs, utc);
  const ix = matchIndex(metric.op, metric.field, metric.groupBy, grid.periodMs, grid.start);
  if (!ix?.points) return empty; // no distributive index satisfies this metric/grid → read records
  const points = ix.points;

  const overlapping = s.currentPlan.filter((f) => overlapsRange(f, range[0], range[1]));
  if (overlapping.length === 0) return empty;

  const q = {
    op: metric.op,
    field: metric.field,
    groupBy: metric.groupBy ?? '',
    from: range[0],
    to: range[1],
    show: showSet,
  };
  const prefix = s.bucket.bucket + SEP;
  const stored = await s.loadIndex(ix);
  const valid = (f: ParsedKey) => {
    const rec = stored.get(prefix + f.key);
    return rec && f.etag && rec.etag === f.etag ? rec : null;
  };
  const extra: WeightedPoint[] = [];
  const covered = new Set<string>();
  const serve = (f: ParsedKey, rec: { payload: unknown }): void => {
    covered.add(f.key);
    const file = { key: f.key, host: f.host, channel: f.channel, interval: f.interval };
    for (const p of points(rec.payload, q, file)) extra.push(p);
  };

  // index-only when every in-range file is covered by a valid stored payload
  if (overlapping.every((f) => valid(f))) {
    for (const f of overlapping) serve(f, valid(f)!);
    return { extra, covered, indexOnly: true };
  }

  // mixed: only not-loaded, fully-in-range files (disjoint from the record read)
  for (const f of overlapping) {
    if (s.store.files.has(f.key)) continue; // loaded → records-served
    const span = intervalSpan(f.interval);
    if (!(span && span[0] >= range[0] && span[1] <= range[1])) continue; // fully in range only
    const rec = valid(f);
    if (rec) serve(f, rec);
  }
  return { extra, covered, indexOnly: false };
}

/**
 * The aggregate solver for grouped, series-shaped metrics (SPEC §11) — e.g.
 * SUM(duration) GROUP BY transaction for the overview chart. It serves each file
 * the cheapest way available: from its persisted index when possible (not
 * loaded, fully in range, ETag-valid, ≥1h aligned grid), else by reading the
 * loaded records. The two sources merge into one tally; the uncovered remainder
 * (budget-refused, un-indexed) becomes the ghost band, partial intervals blank.
 * Reading the records is always the correctness fallback the index optimizes,
 * never replaces.
 */
async function solveSeriesAggregate(
  s: Session,
  metric: Metric,
  range: TimeRange,
  periodMs: number | null,
  utc: boolean,
  /** the transactions to display, each as its own band (the chart's legend
   *  selection). Undefined = default to the top-N by total. Either way there is
   *  no "Other" — the chart shows exactly the chosen/top transactions. */
  show: string[] | undefined,
): Promise<{ result: SeriesResult; ghostSpans: [number, number][]; complete: boolean }> {
  if (metric.groupBy !== 'transaction' || (metric.op !== 'sum' && metric.op !== 'count')) {
    throw new Error(
      `series solver v1 handles count/sum grouped by transaction, not ${metric.op}` +
        (metric.groupBy ? ` by ${metric.groupBy}` : ''),
    );
  }
  if (metric.op === 'sum' && metric.field !== 'duration') {
    throw new Error(`series solver v1 sums only 'duration', not '${metric.field}'`);
  }
  const value = metric.op === 'sum' ? (r: Rec) => r.duration ?? 0 : () => 1;
  const isTxn = (r: Rec) => r.kind === 'transaction';
  const showSet = show && new Set(show);

  // index-served files contribute pre-aggregated points. When EVERY in-range
  // file is index-covered (indexOnly), no records are read — instant, complete,
  // regardless of what's loaded. Otherwise loaded files are records-served and the
  // not-loaded indexed ones merged in (disjoint, no double count).
  const { extra, covered, indexOnly } = range
    ? await indexContributions(s, range, metric, showSet, periodMs, utc)
    : { extra: [] as WeightedPoint[], covered: new Set<string>(), indexOnly: false };

  // explicit selection → show exactly those (include-filtered, all broken out);
  // default → the top-N by total. No "Other" in either case.
  const result = blankPartialSeries(
    aggregateBySeries(
      indexOnly ? [] : s.selectedRecords(),
      range,
      periodMs,
      utc,
      {
        value,
        group: (r) => r.name,
        include: showSet ? (r) => isTxn(r) && showSet.has(r.name) : isTxn,
        topN: showSet ? showSet.size : SERIES_TOP_N,
        noOther: true,
      },
      extra,
    ),
    indexOnly ? [] : incompleteSpans(s, covered),
  );
  const ghostSpans = indexOnly
    ? []
    : mergeSpans(budgetRefusedSpans(s, covered), result.domain[0], result.domain[1]);
  return { result, ghostSpans, complete: ghostSpans.length === 0 };
}

/**
 * The overview as ONE batch (SPEC §11): the chart's Σ-duration series and the
 * table's count / Σ / errors / P95 totals, solved together from a single cube
 * pass + a single histogram pass via the planner — instead of two independent
 * solves each re-reading the cube. Returns null when the batch can't be fully
 * index-served (cold range, sub-hour grid, a missing/stale index) so the caller
 * falls back to the per-metric solves.
 */
async function solveOverviewBatch(
  s: Session,
  range: TimeRange,
  periodMs: number | null,
  utc: boolean,
  show: string[] | undefined,
): Promise<{ series: SeriesResult; groups: TxnGroup[] } | null> {
  if (!range) return null;
  const grid = periodGrid(range[0], range[1], range, periodMs, utc);
  if (!matchIndex('sum', 'duration', 'transaction', grid.periodMs, grid.start)) return null;
  const prefix = s.bucket.bucket + SEP;
  const overlapping = s.currentPlan.filter((f) => overlapsRange(f, range[0], range[1]));
  if (overlapping.length === 0) return null;

  const cube = await s.loadIndex(txnIndex);
  const hist = await s.loadIndex(durHistIndex);
  const cubePayloads: TxnFileIndex[] = [];
  const histPayloads: DurHistFileIndex[] = [];
  for (const f of overlapping) {
    const c = cube.get(prefix + f.key);
    const h = hist.get(prefix + f.key);
    // any in-range file we can't index → not fully coverable → fall back
    if (!c || !h || !f.etag || c.etag !== f.etag || h.etag !== f.etag) return null;
    cubePayloads.push(c.payload);
    histPayloads.push(h.payload);
  }

  const showSet = show && new Set(show);
  const metrics: MetricSpec[] = [
    { key: 'series', op: 'sum', field: 'duration', shape: 'series' },
    { key: 'count', op: 'count', shape: 'total' },
    { key: 'sumDur', op: 'sum', field: 'duration', shape: 'total' },
    { key: 'errors', op: 'sum', field: 'errors', shape: 'total' },
    { key: 'p95', op: 'p95', field: 'duration', shape: 'total' },
  ];
  const { series, totals } = planIndexBatch(
    { metrics, range, periodMs, utc, show: showSet, topN: showSet ? showSet.size : SERIES_TOP_N },
    cubePayloads,
    histPayloads,
  );
  const count = totals.get('count')!;
  const sumDur = totals.get('sumDur')!;
  const errors = totals.get('errors')!;
  const p95 = totals.get('p95')!;
  const groups: TxnGroup[] = [...count].map(([name, c]) => ({
    name,
    count: c,
    totalDuration: sumDur.get(name) ?? 0,
    errors: errors.get(name) ?? 0,
    avg: c > 0 ? (sumDur.get(name) ?? 0) / c : undefined,
    p95: p95.get(name),
  }));
  return { series: series.get('series')!, groups };
}

/**
 * The aggregate payload to merge for one in-range file (SPEC §11): the persisted
 * payload when it matches the file's ETag; otherwise — for a file whose records
 * are loaded but unindexed — the index built in memory on the spot, via the same
 * `build()` the parse path persists (so it merges through the identical code).
 * The `_current` interval is never indexed at parse time, but it's always loaded
 * while it overlaps the working set, so this builds it on demand rather than
 * dropping it. Null only when a file is neither indexed nor loaded — never the
 * `_current` interval, which is the bug this closes.
 */
export function filePayload<P>(
  s: Session,
  ix: AggregateIndex<P>,
  stored: Map<string, StoredIndex<P>>,
  f: ParsedKey,
): P | null {
  const rec = stored.get(s.bucket.bucket + SEP + f.key);
  if (rec && f.etag && rec.etag === f.etag) return rec.payload;
  if (s.store.files.has(f.key)) return ix.build(s.store.recordsOf(f.key));
  return null;
}

/**
 * The transaction TABLE, served entirely from the durable indexes (SPEC §11,
 * #1a). count / Σ duration / errors / avg sum exactly out of the cube; P95 is
 * read off the merged duration-histogram sketch. No records read, no load —
 * instant at any range size, independent of what's in memory. This is the
 * "fastest plan, indexes first" rule: the overview always prefers the index, so
 * its P95 is always the (clearly-marked) estimate. Exact P95 still lives in the
 * drill-down, which reads records for the scatter/histogram anyway.
 */
async function solveTransactionTotals(
  s: Session,
  range: TimeRange,
): Promise<{ groups: TxnGroup[]; p95Estimated: boolean; n: number }> {
  const [from, to] = range ?? operatingRange(s);
  const inRange = s.currentPlan.filter((f) => overlapsRange(f, from, to));

  const cube = await s.loadIndex(txnIndex);
  const totals = new Map<string, TxnTotals>();
  for (const f of inRange) {
    const payload = filePayload(s, txnIndex, cube, f); // index, or built from the loaded _current
    if (payload) mergeRangeTotals(payload, from, to, totals);
  }
  let n = 0;
  for (const t of totals.values()) n += t.c;

  const hist = await s.loadIndex(durHistIndex);
  const merged = new Map<string, Bins>();
  for (const f of inRange) {
    const payload = filePayload(s, durHistIndex, hist, f);
    if (payload) mergeRangeBins(payload, from, to, merged);
  }
  const groups: TxnGroup[] = [...totals].map(([name, t]) => ({
    name,
    count: t.c,
    totalDuration: t.d,
    errors: t.e,
    avg: t.c > 0 ? t.d / t.c : undefined,
    p95: quantileFromBins(merged.get(name) ?? {}, 0.95),
  }));
  return { groups, p95Estimated: true, n };
}

/**
 * The overview's transaction-table totals — the plan is chosen INTERNALLY
 * (SPEC §11): when every in-range file's records are loaded we read them for
 * EXACT totals (incl. exact p95, and correct for sub-hour windows the hourly
 * cube can't tile); otherwise we serve from the index (estimated p95). The
 * caller never picks — it gets the ranking + whether p95 is estimated.
 */
async function solveOverviewTotals(
  s: Session,
  range: TimeRange,
  periodMs: number | null,
  utc: boolean,
): Promise<{ groups: TxnGroup[]; p95Estimated: boolean }> {
  // a sub-hour grid can't be served by the hourly cube (the window may contain
  // no whole-hour bucket) — and its few covering files are loaded for the chart's
  // record read anyway, so read them for exact totals. Coarser grids serve from
  // the index (instant; p95 estimated), avoiding reading a large loaded range.
  const subHour =
    !!range && periodGrid(range[0], range[1], range, periodMs, utc).periodMs < 3_600_000;
  if (subHour) return { groups: groupTransactions(s.selectedRecords(), range), p95Estimated: false };
  const { groups, p95Estimated } = await solveTransactionTotals(s, range);
  return { groups, p95Estimated };
}

/**
 * The overview as ONE solver entry (SPEC §11): chart series + table ranking +
 * completeness, with the plan (index-only batch, record read, on-demand build,
 * hybrid) chosen entirely inside. The op and the view never branch on it — they get
 * { series, groups, ghostSpans, complete, p95Estimated } and render. Whether an
 * index or a scan satisfied any part is the solver's private business.
 */
async function solveOverview(
  s: Session,
  range: TimeRange,
  periodMs: number | null,
  utc: boolean,
  show: string[] | undefined,
): Promise<{
  series: SeriesResult;
  groups: TxnGroup[];
  ghostSpans: [number, number][];
  complete: boolean;
  p95Estimated: boolean;
}> {
  // fastest plan: when the whole overview is index-coverable, one batch pass
  // yields both the series and the table (no records read — instant, complete).
  const batch = await solveOverviewBatch(s, range, periodMs, utc, show);
  if (batch) {
    return { series: batch.series, groups: batch.groups, ghostSpans: [], complete: true, p95Estimated: true };
  }
  // otherwise the series reads loaded records + the not-loaded indexed remainder,
  // and the totals choose their own plan (read records when loaded, else index).
  const metric: Metric = { op: 'sum', field: 'duration', groupBy: 'transaction' };
  const series = await solveSeriesAggregate(s, metric, range, periodMs, utc, show);
  const { groups, p95Estimated } = await solveOverviewTotals(s, range, periodMs, utc);
  return { series: series.result, groups, ghostSpans: series.ghostSpans, complete: series.complete, p95Estimated };
}

/**
 * The drill-down's INDEX-served headline (SPEC §11): count/avg/errors exact from
 * the cube; p50/p95/p99/max and the duration distribution from the sketch
 * (estimated). No records needed, so the detail page shows it instantly.
 */
async function txnSummaryData(s: Session, name: string, range: TimeRange) {
  const [from, to] = range ?? operatingRange(s);

  // sub-hour windows can't be tiled by the hourly cube (the same limitation that
  // blanks the overview) — total the headline from the loaded records, exact,
  // like the scatter/slowest already do. Coarser windows serve from the index
  // (instant, estimated). The plan is chosen HERE, never by the view.
  if (resolvePeriodMs(Math.max(to - from, 1), null) < 3_600_000) {
    const stats = transactionStats(s.selectedNamed(name), name, [from, to]);
    let sum = 0;
    let errors = 0;
    const durations: number[] = [];
    for (const r of stats.instances) {
      sum += r.duration ?? 0;
      if (r.duration !== undefined) durations.push(r.duration);
      if (resultFamily(r) === 'bad') errors++;
    }
    const spanMin = (to - from) / 60_000;
    return {
      name,
      count: stats.count,
      errors,
      avg: stats.count > 0 ? sum / stats.count : undefined,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max: stats.max,
      rpm: stats.count > 0 && spanMin > 0 ? stats.count / spanMin : undefined,
      histogram: logHistogram(durations),
      estimated: false, // exact — read from loaded records
    };
  }

  const inRange = s.currentPlan.filter((f) => overlapsRange(f, from, to));

  const cube = await s.loadIndex(txnIndex);
  const totals = new Map<string, TxnTotals>();
  for (const f of inRange) {
    const payload = filePayload(s, txnIndex, cube, f); // index, or built from the loaded _current
    if (payload) mergeRangeTotals(payload, from, to, totals);
  }
  const t = totals.get(name);

  const hist = await s.loadIndex(durHistIndex);
  const merged = new Map<string, Bins>();
  for (const f of inRange) {
    const payload = filePayload(s, durHistIndex, hist, f);
    if (payload) mergeRangeBins(payload, from, to, merged);
  }
  const bins = merged.get(name) ?? {};
  const binIdxs = Object.keys(bins).map(Number).sort((x, y) => x - y);
  // a HistBin[] straight off the fixed sketch bins (same shape logHistogram
  // produces, so the same renderer draws either)
  const histogram = binIdxs.map((i) => ({ x0: binValue(i), x1: binValue(i + 1), count: bins[i] }));
  const count = t?.c ?? 0;
  const spanMin = (to - from) / 60_000;
  return {
    name,
    count,
    errors: t?.e ?? 0,
    avg: count > 0 ? (t?.d ?? 0) / count : undefined,
    p50: quantileFromBins(bins, 0.5),
    p95: quantileFromBins(bins, 0.95),
    p99: quantileFromBins(bins, 0.99),
    max: binIdxs.length ? binValue(binIdxs[binIdxs.length - 1] + 1) : undefined,
    rpm: count > 0 && spanMin > 0 ? count / spanMin : undefined,
    histogram,
    estimated: true,
  };
}

/**
 * The drill-down's RECORDS-served sections (SPEC §11): result mix + instance
 * samples (scatter / slowest). Built from whatever's loaded — partial while the
 * working set streams in, complete once it settles. The deferred producer for
 * the drill-down; the scatter spans `domain` whole and ghosts `incompleteSpans`.
 */
function txnRecords(s: Session, name: string, range: TimeRange) {
  const stats = transactionStats(s.selectedNamed(name), name, range);
  const [lo, hi] = range ?? operatingRange(s);
  const ghostSpans = mergeSpans(incompleteSpans(s), lo, hi);
  const slowest = [...stats.instances]
    .filter((r) => r.duration !== undefined)
    .sort((a, b) => b.duration! - a.duration!)
    .slice(0, 20);
  const { rows, sample } = sampleInstances(stats.instances);
  return {
    resultCounts: stats.resultCounts,
    instances: rows,
    sample,
    slowest,
    ghostSpans,
    domain: [lo, hi] as [number, number],
  };
}

type OpHandler = (session: Session, args: Record<string, unknown>) => Promise<unknown> | unknown;

const ops: Record<string, OpHandler> = {
  snapshot: (s) => s.snapshot(),

  // ---- scanbar ----
  listChannels: (s) => s.bucket.listChannels(),
  latestInterval: (s, a) => s.bucket.latestInterval(a.channels as string[]),
  /** The complete unique channel + host sets present in a time range — the
   *  candidate options for the channel/host pickers (independent of selection). */
  listFacets: async (s, a) => {
    const startMs = a.startMs as number;
    const endMs = a.endMs as number;
    const channels = await s.bucket.listChannels();
    const startDate = new Date(startMs).toISOString().slice(0, 10);
    const endDate = new Date(endMs).toISOString().slice(0, 10);
    const listings = await Promise.all(channels.map((ch) => s.bucket.listChannelRange(ch, startDate, endDate)));
    const chSet = new Set<string>();
    const hostSet = new Set<string>();
    for (const listing of listings) {
      for (const obj of listing) {
        const p = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
        if (p && overlapsRange(p, startMs, endMs)) {
          chSet.add(p.channel);
          hostSet.add(p.host);
        }
      }
    }
    return { channels: [...chSet].sort(), hosts: [...hostSet].sort() };
  },
  planScan: async (s, a) => {
    const plan = await planScan(
      s.bucket,
      a.channels as string[],
      a.startMs as number,
      a.endMs as number,
      a.hosts as string[] | undefined,
    );
    s.currentPlan = plan.files; // the active selection — for metadata charts + load priority
    // ledger: remember the compressed size of every file in range, even
    // those we never fetch — so we can reason about cost later
    void recordListing(
      s.bucket.bucket,
      plan.files.map((f) => ({ key: f.key, channel: f.channel, interval: f.interval, size: f.size, etag: f.etag })),
    );
    return plan;
  },
  executeScan: (s, a) => {
    if ('range' in a) s.currentRange = (a.range as TimeRange) ?? null;
    s.loader.setBackground(a.background === true); // a prefetch loads throttled
    const plan = a.plan as ScanPlan;
    // ALWAYS additive (SPEC §8): the selection is a view over loaded data, so any
    // change — range, channels, or hosts — keeps every parsed record and fetches
    // only the new plan's missing files. The solver scopes queries to the
    // selection; the store evicts on the memory limit alone.
    s.loader.setPlan(plan.files);
  },
  /** Re-prioritise an in-flight load: foreground (a view now waits on the
   *  records) un-throttles it, background (back to an index-served view) throttles
   *  it. Same plan — just the in-flight cap, so navigating never re-loads. */
  setLoadPriority: (s, a) => {
    s.loader.setBackground(a.background === true);
  },
  clearStore: (s) => {
    s.currentPlan = [];
    s.loader.reset([]); // clears the store, empties the working set
  },
  setLive: (s, a) => {
    s.liveChannels = a.channels as string[];
    // hosts: the active watch set (manual subset or resolved "all current");
    // undefined/absent = all. The scanbar pushes channels/hosts on every replan
    // even when off, so the inspector's demand always has a fresh selection.
    s.liveHostFilter = (a.hosts as string[] | undefined) ?? null;
    s.scanbarLive = a.on === true;
    s.applyLive();
    return s.live.running;
  },
  /** The store inspector demands the latest intervals stay live while it's open,
   *  overriding the scanbar (even a paused / historical-range one) — so the
   *  `_current` files keep updating and their "M:SS ago" counters tick. */
  setInspectorLive: (s, a) => {
    s.inspectorLive = a.on === true;
    s.applyLive();
  },
  /** Which hosts in the selected channels are currently live (fresh `_current`
   *  heartbeat), and whether ANY are — gates the LIVE toggle and resolves the
   *  "all current" host selection (SPEC §6.0). A bucket of only finalized data
   *  (e.g. the public demo) returns none, so live never engages there. */
  liveStatus: async (s, a) => {
    const channels = (a.channels as string[]) ?? [];
    if (channels.length === 0) return { available: false, hosts: [] };
    const hosts = await s.live.currentHosts(channels, Date.now());
    return { available: hosts.length > 0, hosts };
  },

  // ---- store inspector ----
  loadOneFile: (s, a) => loadOneFile(s.store, s.bucket, a.file as ParsedKey, s.cacheLimitBytes),
  /** Fetch a file's metadata sidecar (the .meta.json) for the inspector drawer. */
  getSidecar: (s, a) => s.bucket.getSidecar(a.key as string),
  dropFile: (s, a) => {
    s.store.dropFile(a.key as string);
  },
  cacheKeys: (s) => cacheKeys(s.bucket.bucket),
  /** Factual per-file sizes/counts from sidecars (hydrates the ledger first),
   *  keyed by logical S3 key — so the inspector's rollups are real, not
   *  estimated, for every file whether or not it's loaded. */
  fileFacts: async (s, a) => {
    const files = (a.files as ParsedKey[]) ?? [];
    await hydrateSidecars(s.bucket, files);
    const prefix = s.bucket.bucket + SEP;
    const out: Record<string, { decompressed?: number; records?: number }> = {};
    for (const r of await ledgerRecords(s.bucket.bucket)) {
      if (r.id.startsWith(prefix)) {
        out[r.id.slice(prefix.length)] = { decompressed: r.decompressed, records: r.records };
      }
    }
    return out;
  },
  /** Metrics for the /internals/indexing page: per registered index, its
   *  capability + how much it's storing (files, serialized bytes) + its own
   *  stats (e.g. the duration histogram's bin occupancy). */
  indexStats: async (s) => {
    const out: Record<string, unknown>[] = [];
    for (const ix of INDEXES) {
      const stored = await ix.load(s.bucket.bucket);
      let bytes = 0;
      const payloads: unknown[] = [];
      for (const rec of stored.values()) {
        bytes += JSON.stringify(rec.payload).length;
        payloads.push(rec.payload);
      }
      out.push({
        name: ix.name,
        capability: ix.capability,
        files: stored.size,
        bytes,
        ...(ix.stats ? ix.stats(payloads as never[]) : {}),
      });
    }
    // The origin index is a POINT-LOOKUP index, not an AggregateIndex — reported
    // separately (its own kind + inventory: files indexed, distinct lifetimes).
    const os = originIndexStats(await originIndexRecords(s.bucket.bucket));
    out.push({
      name: 'origin',
      kind: 'point-lookup',
      detail: 'lifetime_id → line  —  client-origin locator, backward-hop resolved',
      files: os.files,
      lifetimes: os.lifetimes,
      locators: os.locators,
      bytes: os.bytes,
    });
    return out;
  },
  /** Can the overview RENDER this range+grid without the working set? — a
   *  load-policy question for the scanbar (#1b): true → the load is just a
   *  background prefetch (so a drill-down is warm); false → the overview needs
   *  the records, load foreground. HOW the solver serves it without records (the
   *  index) is its own business — this only answers whether a load is required. */
  overviewSelfServes: async (s, a) => {
    const range = a.range as TimeRange;
    if (!range) return false;
    const grid = periodGrid(range[0], range[1], range, (a.periodMs as number | null) ?? null, a.utc !== false);
    if (!matchIndex('sum', 'duration', 'transaction', grid.periodMs, grid.start)) return false;
    const overlapping = s.currentPlan.filter((f) => overlapsRange(f, range[0], range[1]));
    if (overlapping.length === 0) return false;
    const prefix = s.bucket.bucket + SEP;
    const cube = await s.loadIndex(txnIndex);
    const hist = await s.loadIndex(durHistIndex);
    return overlapping.every((f) => {
      const c = cube.get(prefix + f.key);
      const h = hist.get(prefix + f.key);
      return !!c && !!h && !!f.etag && c.etag === f.etag && h.etag === f.etag;
    });
  },
  wipeCache: (s) => {
    s.clearIndexCache(); // the wipe deletes the stored indexes too
    return cacheWipeBucket(s.bucket.bucket);
  },
  listAllFiles: async (s) => {
    const channels = await s.bucket.listChannels();
    const listings = await Promise.all(
      channels.map((ch) => s.bucket.listChannelRange(ch, '0000-01-01', '9999-12-31')),
    );
    const all: ParsedKey[] = [];
    for (const listing of listings) {
      for (const obj of listing) {
        const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
        if (parsed) all.push(parsed);
      }
    }
    return dedupeCurrents(all).sort((a, b) =>
      a.interval === b.interval ? a.key.localeCompare(b.key) : b.interval.localeCompare(a.interval),
    );
  },
  /** per-file record counts by kind (inspector rows) — small, bounded */
  fileKindCounts: (s) => {
    const counts = new Map<string, Map<RecordKind, number>>();
    for (const rec of s.store.records) {
      let c = counts.get(rec.sourceKey);
      if (!c) {
        c = new Map();
        counts.set(rec.sourceKey, c);
      }
      c.set(rec.kind, (c.get(rec.kind) ?? 0) + 1);
    }
    return counts;
  },

  // ---- views ----
  // The overview's data: the series-shaped chart aggregate (solved by the
  // aggregate solver — SPEC §11 — so the caller never learns whether records or
  // an index satisfied it; it gets the tally, the displayed series, and
  // completeness) plus the transaction-table ranking. The chart names the metric
  // it wants — SUM(duration) GROUP BY transaction — and optionally `show`, the
  // exact transactions to display (its legend selection); absent → top-N.
  overviewData: (s, a) =>
    solveOverview(
      s,
      a.range as TimeRange,
      a.periodMs as number | null,
      a.utc !== false, // align the period grid to the active display zone
      a.show as string[] | undefined,
    ),

  /** The drill-down as one plan (SPEC §11): the index-served summary (count,
   *  percentiles, distribution) returns immediately, alongside the current
   *  records sections (result mix, scatter, slowest — partial while loading) and,
   *  when more records are still to come, a `token`. The records sections then
   *  stream back under that token as the working-set load fills in (the deferred
   *  path), so the page shows its headline instantly and fills the rest in. */
  solveTransaction: async (s, a) => {
    const name = a.name as string;
    const range = a.range as TimeRange;
    const [lo, hi] = range ?? operatingRange(s);
    const summary = await txnSummaryData(s, name, range);
    const records = txnRecords(s, name, range);
    // more records to come? — any in-range file not yet loaded. If everything's
    // loaded (or there's nothing here — a cold range the view shows as loading,
    // not via a token it won't subscribe to) the records are final; otherwise
    // stream updates under a token.
    const complete =
      summary.count === 0 ||
      s.currentPlan.filter((f) => overlapsRange(f, lo, hi)).every((f) => s.store.files.has(f.key));
    const token = complete ? null : s.addDeferred(() => txnRecords(s, name, range));
    return { summary, records, token };
  },

  /** The index-served headline alone — for an in-place refresh as the working
   *  set (notably the loaded `_current` interval) streams in, without tearing
   *  down the drill-down's structure or its records subscription. */
  txnSummary: (s, a) => txnSummaryData(s, a.name as string, a.range as TimeRange),

  traceData: (s, a) => assembleTrace(s.store.traceRecords(a.traceId as string), a.traceId as string),

  recordsPage: (s, a) => {
    const kinds = new Set(a.kinds as RecordKind[]);
    const levels = new Set(a.levels as string[]);
    const channel = a.channel as string | null;
    const host = (a.host as string | null) ?? null;
    const q = ((a.q as string) ?? '').toLowerCase();
    const pool = rangeSlice(s.selectedRecords(), a.range as TimeRange);
    const filtered = pool.filter((r) => {
      if (!kinds.has(r.kind)) return false;
      if (r.kind === 'event' && r.level && !levels.has(r.level)) return false;
      if (channel && r.channel !== channel) return false;
      if (host && r.host !== host) return false;
      if (q) {
        const hay = `${r.name} ${r.message ?? ''} ${r.userId ?? ''} ${r.traceId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) {
          if (r.rawLine === null || !r.rawLine.toLowerCase().includes(q)) return false;
        }
      }
      return true;
    });
    if (a.newestFirst) filtered.reverse();
    const offset = a.offset as number;
    return { total: filtered.length, rows: filtered.slice(offset, offset + (a.limit as number)) };
  },

  eventsPage: (s, a) => {
    const levels = new Set(a.levels as string[]);
    const type = a.type as string | null;
    const channel = a.channel as string | null;
    const user = ((a.user as string) ?? '').trim();
    const q = ((a.q as string) ?? '').toLowerCase();
    const range = (a.contextWindow as TimeRange) ?? (a.range as TimeRange);
    const pool = rangeSlice(
      mergeByTime(s.selectedKind('event'), s.selectedKind('error')),
      range,
    );
    const typeCounts = new Map<string, number>();
    const levelCounts = new Map<string, number>();
    const filtered: Rec[] = [];
    for (const r of pool) {
      if (r.level) levelCounts.set(r.level, (levelCounts.get(r.level) ?? 0) + 1);
      if (r.level && !levels.has(r.level)) continue;
      if (channel && r.channel !== channel) continue;
      if (user && r.userId !== user) continue;
      if (q) {
        const hay = `${r.name} ${r.message ?? ''} ${r.userId ?? ''}`.toLowerCase();
        if (!hay.includes(q) && (r.rawLine === null || !r.rawLine.toLowerCase().includes(q))) {
          continue;
        }
      }
      // facets count the would-be matches of every type, then narrow
      typeCounts.set(r.name, (typeCounts.get(r.name) ?? 0) + 1);
      if (type && r.name !== type) continue;
      filtered.push(r);
    }
    if (a.newestFirst) filtered.reverse();
    const offset = a.offset as number;
    return {
      total: filtered.length,
      rows: filtered.slice(offset, offset + (a.limit as number)),
      typeCounts,
      levelCounts,
      poolTotal: pool.length,
    };
  },

  metricsData: (s, a) => {
    const range = a.range as TimeRange;
    const utc = a.utc !== false; // align the breakdown period grid to the active zone
    const sets = s.selectedKind('metricset');
    const series = new Map<string, Map<string, { t: number; v: number }[]>>();
    for (const name of a.sampleNames as string[]) {
      series.set(name, runtimeSeries(sets, name, range));
    }
    return {
      series,
      breakdown: breakdownSelfTime(sets, range, a.periodMs as number | null, utc),
      markers: deploymentMarkers(s.selectedRecords()),
    };
  },

  clientsData: (s, a) => {
    const range = a.range as TimeRange;
    const pool = mergeByTime(s.selectedKind('event'), s.selectedKind('error'));
    return {
      profiles: clientProfiles(pool, range),
      versions: appVersions(pool, range),
      slow: slowClientEvents(pool, range).slice(0, MAX_SLOW_EVENTS),
      types: clientEventTypes(pool, range),
    };
  },

  scannerData: (s, a) => scannerStats(s.selectedKind('transaction'), a.range as TimeRange),

  /** raw body for the drawer: retained line, else stream the file to line N.
   *  Finalized files are cached compressed — we inflate just up to the line and
   *  stop (gunzipLineN). A volatile/uncached file is fetched inflated and read
   *  by index. Neither holds the decompressed body (SPEC §8). */
  rawBody: async (s, a) => {
    const rec = a.rec as Pick<Rec, 'rawLine' | 'sourceKey' | 'line' | 'kind'>;
    try {
      let line = rec.rawLine;
      if (line === null) {
        const done = perf.begin('fetch', rec.sourceKey);
        const gz = await cacheGetAny(s.bucket.bucket, rec.sourceKey);
        if (gz && isGzip(gz)) {
          line = await gunzipLineN(gz, rec.line); // cached gz → inflate to line N, stop
          done({ detail: `raw line ${rec.line}`, bytes: gz.length, cached: true });
        } else {
          // uncached (or volatile _current) → fetch inflated, read by index
          const bytes = gz ?? (await s.bucket.getObjectBytes(rec.sourceKey));
          done({ detail: `raw line ${rec.line}`, bytes: bytes.length, cached: gz !== null });
          line = nthLine(new TextDecoder().decode(bytes), rec.line);
        }
      }
      if (line === null) return {};
      const obj = JSON.parse(line) as Record<string, unknown>;
      const body = obj[rec.kind];
      return body && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  },
};

/** Wire one tab's port: attach creates/joins a session, then ops flow. */
export function handlePort(port: PortLike & { onmessage?: unknown }): void {
  allPorts.add(port);
  let session: Session | null = null;
  (port as { onmessage: (ev: MessageEvent) => void }).onmessage = (ev: MessageEvent) => {
    const msg = ev.data as Request & { profile?: Profile; cancelDeferred?: string };
    void (async () => {
      try {
        if (msg.cancelDeferred) {
          session?.cancelDeferred(msg.cancelDeferred); // view gone → stop producing
          return;
        }
        if (msg.op === 'attach') {
          session?.ports.delete(port);
          session = getSession(msg.profile!);
          session.ports.add(port);
          // a page (re)load starts with no live demands — the store view's
          // teardown never runs on reload, so its `inspectorLive` would otherwise
          // persist in this (worker-lived) session and keep live running forever.
          // The store view + scanbar re-assert their demands as they mount.
          session.inspectorLive = false;
          session.applyLive();
          port.postMessage({ id: msg.id, ok: true, result: session.snapshot() });
          return;
        }
        if (!session) throw new Error('not attached');
        session.lastUsed = Date.now();
        const handler = ops[msg.op];
        if (!handler) throw new Error(`unknown op: ${msg.op}`);
        const result = await handler(session, msg.args ?? {});
        port.postMessage({ id: msg.id, ok: true, result } satisfies Outbound);
      } catch (err) {
        port.postMessage({
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Outbound);
      }
    })();
  };
}
