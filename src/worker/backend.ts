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
import { cacheKeys, cacheWipeBucket, cacheGetAny, SEP } from '../data/cache';
import { gunzipLineN, isGzip } from '../data/gzip';
import { parseKey, dedupeCurrents, overlapsRange, intervalSpan, type ParsedKey } from '../s3/keys';
import { nthLine } from '../data/parse';
import type { Rec, RecordKind } from '../data/types';
import {
  aggregateBySeries,
  blankPartialSeries,
  bucketGrid,
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
import { recordListing, estimatePlan, ledgerRecords } from '../data/ledger';
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

/** MB → bytes, or null when no limit is set. */
function mbToBytes(mb: number | undefined): number | null {
  return mb != null && mb > 0 ? mb * 1024 * 1024 : null;
}

class Session {
  store = new Store();
  bucket: LogBucket;
  live: LiveUpdater;
  liveChannels: string[] = [];
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
      () => this.currentRange,
    );
    this.live = new LiveUpdater(this.store, this.bucket, () => this.liveChannels);
    this.store.addEventListener('data', () => {
      this.broadcast('data');
      void this.fireDeferred();
    });
    this.store.addEventListener('progress', () => {
      this.broadcast('progress');
      void this.fireDeferred();
    });
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
 * ALL accounted for yet — used to blank partially-covered buckets, so an
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
 *    scan, no double count); the rest are scanned. The fallback for cold ranges,
 *    sub-hour grids, or a file whose index is missing/stale.
 */
async function indexContributions(
  s: Session,
  range: [number, number],
  metric: Metric,
  showSet: Set<string> | undefined,
  bucketMs: number | null,
  utc: boolean,
): Promise<{ extra: WeightedPoint[]; covered: Set<string>; indexOnly: boolean }> {
  const empty = { extra: [] as WeightedPoint[], covered: new Set<string>(), indexOnly: false };
  const grid = bucketGrid(range[0], range[1], range, bucketMs, utc);
  const ix = matchIndex(metric.op, metric.field, metric.groupBy, grid.bucketMs, grid.start);
  if (!ix?.points) return empty; // no distributive index satisfies this metric/grid → scan
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

  // mixed: only not-loaded, fully-in-range files (disjoint from the scan)
  for (const f of overlapping) {
    if (s.store.files.has(f.key)) continue; // loaded → scanned
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
 * loaded, fully in range, ETag-valid, ≥1h aligned grid), else by scanning the
 * loaded records. The two sources merge into one tally; the uncovered remainder
 * (budget-refused, un-indexed) becomes the ghost band, partial intervals blank.
 * The scan is always the correctness fallback the index optimizes, never replaces.
 */
async function solveSeriesAggregate(
  s: Session,
  metric: Metric,
  range: TimeRange,
  bucketMs: number | null,
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
  // file is index-covered (indexOnly), nothing is scanned — instant, complete,
  // regardless of what's loaded. Otherwise loaded files are scanned and the
  // not-loaded indexed ones merged in (disjoint, no double count).
  const { extra, covered, indexOnly } = range
    ? await indexContributions(s, range, metric, showSet, bucketMs, utc)
    : { extra: [] as WeightedPoint[], covered: new Set<string>(), indexOnly: false };

  // explicit selection → show exactly those (include-filtered, all broken out);
  // default → the top-N by total. No "Other" in either case.
  const result = blankPartialSeries(
    aggregateBySeries(
      indexOnly ? [] : s.store.records,
      range,
      bucketMs,
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
  bucketMs: number | null,
  utc: boolean,
  show: string[] | undefined,
): Promise<{ series: SeriesResult; groups: TxnGroup[] } | null> {
  if (!range) return null;
  const grid = bucketGrid(range[0], range[1], range, bucketMs, utc);
  if (!matchIndex('sum', 'duration', 'transaction', grid.bucketMs, grid.start)) return null;
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
    { metrics, range, bucketMs, utc, show: showSet, topN: showSet ? showSet.size : SERIES_TOP_N },
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
 * The transaction TABLE, served entirely from the durable indexes (SPEC §11,
 * #1a). count / Σ duration / errors / avg sum exactly out of the cube; P95 is
 * read off the merged duration-histogram sketch. No record scan, no load —
 * instant at any range size, independent of what's in memory. This is the
 * "fastest plan, indexes first" rule: the overview always prefers the index, so
 * its P95 is always the (clearly-marked) estimate. Exact P95 still lives in the
 * drill-down, which scans for the scatter/histogram anyway.
 */
async function solveTransactionTotals(
  s: Session,
  range: TimeRange,
): Promise<{ groups: TxnGroup[]; p95Estimated: boolean; n: number }> {
  const [from, to] = range ?? operatingRange(s);
  const prefix = s.bucket.bucket + SEP;
  const inRange = s.currentPlan.filter((f) => overlapsRange(f, from, to));

  const cube = await s.loadIndex(txnIndex);
  const totals = new Map<string, TxnTotals>();
  for (const f of inRange) {
    const rec = cube.get(prefix + f.key);
    if (!rec || !f.etag || rec.etag !== f.etag) continue; // unindexed/stale → omitted
    mergeRangeTotals(rec.payload, from, to, totals);
  }
  let n = 0;
  for (const t of totals.values()) n += t.c;

  const hist = await s.loadIndex(durHistIndex);
  const merged = new Map<string, Bins>();
  for (const f of inRange) {
    const rec = hist.get(prefix + f.key);
    if (!rec || !f.etag || rec.etag !== f.etag) continue;
    mergeRangeBins(rec.payload, from, to, merged);
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
 * The drill-down's INDEX-served headline (SPEC §11): count/avg/errors exact from
 * the cube; p50/p95/p99/max and the duration distribution from the sketch
 * (estimated). No records needed, so the detail page shows it instantly.
 */
async function txnSummaryData(s: Session, name: string, range: TimeRange) {
  const [from, to] = range ?? operatingRange(s);
  const prefix = s.bucket.bucket + SEP;
  const inRange = s.currentPlan.filter((f) => overlapsRange(f, from, to));

  const cube = await s.loadIndex(txnIndex);
  const totals = new Map<string, TxnTotals>();
  for (const f of inRange) {
    const rec = cube.get(prefix + f.key);
    if (rec && f.etag && rec.etag === f.etag) mergeRangeTotals(rec.payload, from, to, totals);
  }
  const t = totals.get(name);

  const hist = await s.loadIndex(durHistIndex);
  const merged = new Map<string, Bins>();
  for (const f of inRange) {
    const rec = hist.get(prefix + f.key);
    if (rec && f.etag && rec.etag === f.etag) mergeRangeBins(rec.payload, from, to, merged);
  }
  const bins = merged.get(name) ?? {};
  const binIdxs = Object.keys(bins).map(Number).sort((x, y) => x - y);
  // a HistBucket[] straight off the fixed sketch bins (same shape logHistogram
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
  const stats = transactionStats(s.store.transactionsNamed(name), name, range);
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
  estimateView: async (s, a) => {
    const files = (a.files as ParsedKey[]) ?? [];
    // pull sidecars into the ledger first, so the estimate is factual (exact
    // decompressed bytes) rather than ratio-based wherever a sidecar exists
    await hydrateSidecars(s.bucket, files);
    return estimatePlan(
      s.bucket.bucket,
      files.map((f) => ({ key: f.key, channel: f.channel, compressed: f.size })),
    );
  },
  executeScan: async (s, a) => {
    // a channel/range change is a *new plan*: reset the working-set loader to
    // the executed plan (possibly a memory-clamped subset of the selection)
    if ('range' in a) s.currentRange = (a.range as TimeRange) ?? null;
    // exact decompressed size per file from the sidecars (hydrated by the
    // preceding estimateView), so progress reports in-memory bytes, not download
    const prefix = s.bucket.bucket + SEP;
    const decompressedByKey = new Map<string, number>();
    for (const r of await ledgerRecords(s.bucket.bucket)) {
      if (r.decompressed != null && r.id.startsWith(prefix)) {
        decompressedByKey.set(r.id.slice(prefix.length), r.decompressed);
      }
    }
    s.loader.setBackground(a.background === true); // a prefetch loads throttled
    const plan = a.plan as ScanPlan;
    // additive on a range change (keep parsed records, fetch only the delta);
    // wipe only when the channel selection changes (SPEC §8)
    s.loader.setPlan(plan.files, plan.channels, decompressedByKey);
  },
  /** Re-prioritise an in-flight load: foreground (a view now waits on the
   *  records) un-throttles it, background (back to an index-served view) throttles
   *  it. Same plan — just the in-flight cap, so navigating never re-loads. */
  setLoadPriority: (s, a) => {
    s.loader.setBackground(a.background === true);
  },
  clearStore: (s) => {
    s.currentPlan = [];
    s.loader.reset([]); // clears store + mem, empties the working set
  },
  setLive: (s, a) => {
    s.liveChannels = a.channels as string[];
    if (a.on) s.live.start();
    else s.live.stop();
    return s.live.running;
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
    return out;
  },
  /** Can the overview be served entirely from the durable indexes for this
   *  range+grid? — i.e. an index matches the chart grid AND every in-range file
   *  has a valid (ETag-matching) cube AND histogram. The scanbar uses this to
   *  decide whether to load raw records at all (#1b): true → serve from indexes,
   *  no load; false (cold range, sub-hour grid, missing/stale index) → load,
   *  which also (re)builds the indexes. */
  overviewIndexed: async (s, a) => {
    const range = a.range as TimeRange;
    if (!range) return false;
    const grid = bucketGrid(range[0], range[1], range, (a.bucketMs as number | null) ?? null, a.utc !== false);
    if (!matchIndex('sum', 'duration', 'transaction', grid.bucketMs, grid.start)) return false;
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
  /** Tuning aid for the /internals/indexing page: per transaction, the EXACT
   *  P95 (from loaded records) beside the ESTIMATED P95 the holistic histogram
   *  merge produces — so we can see the bin-resolution error on real data and
   *  decide whether 5 bins/decade is enough. The merge is restricted to LOADED
   *  files so both sides cover the same records (isolating bin error, not a
   *  loaded-vs-all-files population gap). */
  p95Accuracy: async (s, a) => {
    const range = a.range as TimeRange;
    const [from, to] = range ?? operatingRange(s);
    const prefix = s.bucket.bucket + SEP;
    const merged = new Map<string, Bins>();
    for (const [id, rec] of await s.loadIndex(durHistIndex)) {
      if (s.store.files.has(id.slice(prefix.length))) mergeRangeBins(rec.payload, from, to, merged);
    }
    return groupTransactions(s.store.kindRecords('transaction'), range)
      .filter((g) => g.p95 !== undefined)
      .map((g) => {
        const exact = g.p95!;
        const estimated = quantileFromBins(merged.get(g.name) ?? {}, 0.95);
        return {
          name: g.name,
          n: g.count,
          exact,
          estimated,
          errorPct: estimated !== undefined ? (Math.abs(estimated - exact) / exact) * 100 : null,
        };
      })
      .sort((a2, b) => b.n - a2.n);
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
  overviewData: async (s, a) => {
    const range = a.range as TimeRange;
    const bucketMs = a.bucketMs as number | null;
    const utc = a.utc !== false; // align the bucket grid to the active display zone
    const metric = (a.metric as Metric | undefined) ?? {
      op: 'sum',
      field: 'duration',
      groupBy: 'transaction',
    };
    const show = a.show as string[] | undefined;

    // fastest plan: when the whole overview is index-coverable, solve the chart
    // series and the table totals as ONE batch — a single cube pass + histogram
    // pass for both, instead of two solves each re-reading the cube (SPEC §11).
    const batch = await solveOverviewBatch(s, range, bucketMs, utc, show);
    if (batch) {
      return {
        series: batch.series,
        ghostSpans: [] as [number, number][],
        complete: true,
        groups: batch.groups,
        p95Estimated: true,
      };
    }

    // fallback (cold range / sub-hour grid / a missing index): the chart scans
    // the loaded records + the not-loaded indexed remainder; the table is still
    // index-served. Two solves, each reading the cube.
    const { result, ghostSpans, complete } = await solveSeriesAggregate(
      s,
      metric,
      range,
      bucketMs,
      utc,
      show,
    );
    const { groups, p95Estimated } = await solveTransactionTotals(s, range);
    return { series: result, ghostSpans, complete, groups, p95Estimated };
  },

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

  traceData: (s, a) => assembleTrace(s.store.traceRecords(a.traceId as string), a.traceId as string),

  recordsPage: (s, a) => {
    const kinds = new Set(a.kinds as RecordKind[]);
    const levels = new Set(a.levels as string[]);
    const channel = a.channel as string | null;
    const host = (a.host as string | null) ?? null;
    const q = ((a.q as string) ?? '').toLowerCase();
    const pool = rangeSlice(s.store.records, a.range as TimeRange);
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
      mergeByTime(s.store.kindRecords('event'), s.store.kindRecords('error')),
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
    const utc = a.utc !== false; // align the breakdown bucket grid to the active zone
    const sets = s.store.kindRecords('metricset');
    const series = new Map<string, Map<string, { t: number; v: number }[]>>();
    for (const name of a.sampleNames as string[]) {
      series.set(name, runtimeSeries(sets, name, range));
    }
    return {
      series,
      breakdown: breakdownSelfTime(sets, range, a.bucketMs as number | null, utc),
      markers: deploymentMarkers(s.store.records),
    };
  },

  clientsData: (s, a) => {
    const range = a.range as TimeRange;
    const pool = mergeByTime(s.store.kindRecords('event'), s.store.kindRecords('error'));
    return {
      profiles: clientProfiles(pool, range),
      versions: appVersions(pool, range),
      slow: slowClientEvents(pool, range).slice(0, MAX_SLOW_EVENTS),
      types: clientEventTypes(pool, range),
    };
  },

  scannerData: (s, a) => scannerStats(s.store.kindRecords('transaction'), a.range as TimeRange),

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
