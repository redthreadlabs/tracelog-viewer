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
import { cacheKeys, cacheWipeBucket, SEP } from '../data/cache';
import { MemBytes, cachedDecompressedAny } from '../data/blobs';
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
  logHistogram,
  type SeriesResult,
  type WeightedPoint,
  type TxnGroup,
} from '../data/aggregate';
import { matchIndex, INDEXES, TXN_EXACT_P95_MAX } from '../data/indexes';
import { durHistRecords, mergeRangeBins, quantileFromBins, type Bins } from '../data/durhist';
import { txnIndexRecords, mergeRangeTotals, type TxnTotals } from '../data/txnindex';
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
  | { ev: 'perf'; entry: PerfEntry };

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
  /** hot decompressed-byte cache, bounded by the workspace memory limit */
  mem: MemBytes;
  /** the current selection's files (set by planScan) — the FULL selection, used
   *  by metadata-served charts (may exceed what the loader is loading if the
   *  load was clamped to a memory budget) */
  currentPlan: ParsedKey[] = [];
  /** the user's focused time range (brush) — narrows the loader's working set
   *  so a zoom loads (and reports progress for) only its covering files */
  currentRange: TimeRange = null;
  /** the working-set loader — re-scoped on range change, reset on new plan */
  loader: LoadController;
  constructor(profile: Profile) {
    this.bucket = new LogBucket(profile);
    this.cacheLimitBytes = mbToBytes(profile.cacheLimitMb);
    this.mem = new MemBytes(mbToBytes(profile.memoryLimitMb));
    this.loader = new LoadController(
      this.store,
      this.bucket,
      this.mem,
      this.cacheLimitBytes,
      () => this.currentRange,
    );
    this.live = new LiveUpdater(this.store, this.bucket, () => this.liveChannels);
    this.store.addEventListener('data', () => this.broadcast('data'));
    this.store.addEventListener('progress', () => this.broadcast('progress'));
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
 * this grid; if so, each selected file that is NOT loaded, whose interval lies
 * FULLY inside the range, and whose stored index is ETag-valid contributes its
 * rollups as weighted points and is marked "covered". Restricting to not-loaded,
 * fully-in-range files keeps it disjoint from the record scan (no double count)
 * and avoids splitting a rollup bucket at a range edge.
 */
async function indexContributions(
  s: Session,
  range: [number, number],
  metric: Metric,
  showSet: Set<string> | undefined,
  bucketMs: number | null,
  utc: boolean,
): Promise<{ extra: WeightedPoint[]; covered: Set<string> }> {
  const empty = { extra: [] as WeightedPoint[], covered: new Set<string>() };
  const grid = bucketGrid(range[0], range[1], range, bucketMs, utc);
  const ix = matchIndex(metric.op, metric.field, metric.groupBy, grid.bucketMs, grid.start);
  if (!ix?.points) return empty; // no distributive index satisfies this metric/grid → scan
  const points = ix.points;

  // candidates: selected files that aren't loaded and lie fully inside the range
  // (so an index could cover them). When everything is loaded — the common
  // in-budget case — there are none, so we skip the IndexedDB read entirely.
  const candidates = s.currentPlan.filter((f) => {
    if (s.store.files.has(f.key)) return false; // loaded → scanned, not indexed (no double count)
    const span = intervalSpan(f.interval);
    return !!span && span[0] >= range[0] && span[1] <= range[1];
  });
  if (candidates.length === 0) return empty;

  const q = {
    op: metric.op,
    field: metric.field,
    groupBy: metric.groupBy ?? '',
    from: range[0],
    to: range[1],
    show: showSet,
  };
  const stored = await ix.load(s.bucket.bucket);
  const extra: WeightedPoint[] = [];
  const covered = new Set<string>();
  for (const f of candidates) {
    const rec = stored.get(s.bucket.bucket + SEP + f.key);
    if (!rec || !f.etag || rec.etag !== f.etag) continue; // no index, or unverifiable/stale
    covered.add(f.key);
    const file = { key: f.key, host: f.host, channel: f.channel, interval: f.interval };
    for (const p of points(rec.payload, q, file)) extra.push(p);
  }
  return { extra, covered };
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

  // index-served files (not loaded, fully in range) contribute pre-aggregated
  // points; loaded files are scanned. Disjoint, so no double count.
  const { extra, covered } = range
    ? await indexContributions(s, range, metric, showSet, bucketMs, utc)
    : { extra: [] as WeightedPoint[], covered: new Set<string>() };

  // explicit selection → show exactly those (include-filtered, all broken out);
  // default → the top-N by total. No "Other" in either case.
  const result = blankPartialSeries(
    aggregateBySeries(
      s.store.records,
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
    incompleteSpans(s, covered),
  );
  const ghostSpans = mergeSpans(budgetRefusedSpans(s, covered), result.domain[0], result.domain[1]);
  return { result, ghostSpans, complete: ghostSpans.length === 0 };
}

/**
 * The transaction TABLE, solver-served (SPEC §11). count / Σ duration / errors /
 * avg are distributive — always exact, from the cube — so they need no record
 * scan even for a 90-day range. P95 is holistic; its source is chosen up front
 * from the cube's EXACT in-range count (the cost driver of an exact pass, known
 * without scanning): below the threshold AND fully loaded → exact scan+sort;
 * otherwise the merged-histogram ESTIMATE (instant, no scan, no load). So the
 * table is always complete and instant; only P95's precision flips.
 */
async function solveTransactionTotals(
  s: Session,
  range: TimeRange,
): Promise<{ groups: TxnGroup[]; p95Estimated: boolean; n: number }> {
  const [from, to] = range ?? operatingRange(s);
  const prefix = s.bucket.bucket + SEP;
  const inRange = s.currentPlan.filter((f) => overlapsRange(f, from, to));
  const fullyLoaded = inRange.every((f) => s.store.files.has(f.key));

  // exact P95 needs every in-range duration in memory, and a scan+sort cheap
  // enough to be worth it. When fully loaded we know N from the store itself
  // (O(log n), no IndexedDB) — so the common small-range case never reads the
  // cube at all; it just scans, exactly as before.
  if (fullyLoaded) {
    const txns = s.store.kindRecords('transaction');
    const n = rangeSlice(txns, range).length;
    if (n <= TXN_EXACT_P95_MAX) {
      return { groups: groupTransactions(txns, range), p95Estimated: false, n };
    }
  }

  // estimated path: cube totals + a P95 read off the merged duration histograms
  // of the same in-range files. No record scan, no load — instant at any size.
  const cube = new Map((await txnIndexRecords(s.bucket.bucket)).map((r) => [r.id, r]));
  const totals = new Map<string, TxnTotals>();
  for (const f of inRange) {
    const rec = cube.get(prefix + f.key);
    if (!rec || !f.etag || rec.etag !== f.etag) continue; // unindexed/stale → omitted
    mergeRangeTotals(rec.index, from, to, totals);
  }
  let n = 0;
  for (const t of totals.values()) n += t.c;

  const hist = new Map((await durHistRecords(s.bucket.bucket)).map((r) => [r.id, r]));
  const merged = new Map<string, Bins>();
  for (const f of inRange) {
    const rec = hist.get(prefix + f.key);
    if (!rec || !f.etag || rec.etag !== f.etag) continue;
    mergeRangeBins(rec.index, from, to, merged);
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
    s.loader.reset((a.plan as ScanPlan).files, decompressedByKey);
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
  loadOneFile: (s, a) => loadOneFile(s.store, s.bucket, a.file as ParsedKey, s.cacheLimitBytes, s.mem),
  /** Fetch a file's metadata sidecar (the .meta.json) for the inspector drawer. */
  getSidecar: (s, a) => s.bucket.getSidecar(a.key as string),
  dropFile: (s, a) => {
    const key = a.key as string;
    s.store.dropFile(key);
    s.mem.delete(key);
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
    for (const r of await durHistRecords(s.bucket.bucket)) {
      if (s.store.files.has(r.id.slice(prefix.length))) mergeRangeBins(r.index, from, to, merged);
    }
    // the cube's exact in-range count — the same N the solver thresholds on to
    // pick exact vs estimated P95 (shown beside the threshold on the page)
    const cube = new Map((await txnIndexRecords(s.bucket.bucket)).map((r) => [r.id, r]));
    const cubeTotals = new Map<string, TxnTotals>();
    for (const f of s.currentPlan) {
      if (!overlapsRange(f, from, to)) continue;
      const rec = cube.get(prefix + f.key);
      if (rec && f.etag && rec.etag === f.etag) mergeRangeTotals(rec.index, from, to, cubeTotals);
    }
    let txnCount = 0;
    for (const t of cubeTotals.values()) txnCount += t.c;

    const rows = groupTransactions(s.store.kindRecords('transaction'), range)
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
    return { threshold: TXN_EXACT_P95_MAX, txnCount, rows };
  },
  wipeCache: (s) => {
    s.mem.clear();
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

    const { result, ghostSpans, complete } = await solveSeriesAggregate(
      s,
      metric,
      range,
      bucketMs,
      utc,
      show,
    );

    // the table lists ALL transactions (so any can be toggled into the chart),
    // independent of which the chart is currently displaying — solver-served, so
    // it's complete and instant whether or not the records are loaded
    const { groups, p95Estimated } = await solveTransactionTotals(s, range);
    return { series: result, ghostSpans, complete, groups, p95Estimated };
  },

  txnDetail: (s, a) => {
    const range = a.range as TimeRange;
    const stats = transactionStats(
      s.store.transactionsNamed(a.name as string),
      a.name as string,
      range,
    );
    // the drill-down is records-based, so over-budget intervals (records the
    // budget refused) are simply absent — surface them as the ghost band so
    // the scatter/histogram don't pass off a partial view as complete (SPEC §7)
    const [lo, hi] = range ?? operatingRange(s);
    const ghostSpans = mergeSpans(budgetRefusedSpans(s), lo, hi);
    const durations = stats.instances
      .map((r) => r.duration)
      .filter((d): d is number => d !== undefined);
    const slowest = [...stats.instances]
      .filter((r) => r.duration !== undefined)
      .sort((a2, b) => b.duration! - a2.duration!)
      .slice(0, 20);
    const { rows, sample } = sampleInstances(stats.instances);
    return {
      name: stats.name,
      count: stats.count,
      p50: stats.p50,
      p95: stats.p95,
      p99: stats.p99,
      max: stats.max,
      rpm: stats.rpm,
      resultCounts: stats.resultCounts,
      histogram: logHistogram(durations),
      instances: rows,
      sample,
      slowest,
      ghostSpans,
    };
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

  /** raw body for the drawer: retained line, cached file, or the bucket */
  rawBody: async (s, a) => {
    const rec = a.rec as Pick<Rec, 'rawLine' | 'sourceKey' | 'line' | 'kind'>;
    try {
      let line = rec.rawLine;
      if (line === null) {
        const done = perf.begin('fetch', rec.sourceKey);
        let bytes = await cachedDecompressedAny(s.mem, s.bucket.bucket, rec.sourceKey);
        const fromCache = bytes !== null;
        if (!bytes) bytes = await s.bucket.getObjectBytes(rec.sourceKey);
        done({ detail: `raw line ${rec.line}`, bytes: bytes.length, cached: fromCache });
        line = nthLine(new TextDecoder().decode(bytes), rec.line);
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
    const msg = ev.data as Request & { profile?: Profile };
    void (async () => {
      try {
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
