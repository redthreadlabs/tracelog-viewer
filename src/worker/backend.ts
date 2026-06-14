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
import { Store, mergeByTime, windowBounds, windowSlice } from '../data/store';
import type { FileInfo, ScanProgress } from '../data/store';
import { LogBucket } from '../s3/client';
import type { Profile } from '../ui/profiles';
import { planScan, type ScanPlan } from '../s3/scanner';
import {
  LoadController,
  loadOneFile,
  hydrateSidecars,
  hydrateSidecarsInBackground,
  SIDECAR_PREFETCH_HORIZON_MS,
} from '../data/scan';
import { LiveUpdater } from '../data/live';
import { perf, type PerfEntry } from '../data/perf';
import { cacheKeys, cacheWipeBucket, SEP } from '../data/cache';
import { MemBytes, cachedDecompressedAny } from '../data/blobs';
import { parseKey, dedupeCurrents, overlapsRange, intervalSpan, type ParsedKey } from '../s3/keys';
import { nthLine } from '../data/parse';
import type { Rec, RecordKind } from '../data/types';
import {
  bucketByTime,
  bucketBySidecar,
  blankPartialBuckets,
  chooseBucketMs,
  groupTransactions,
  transactionStats,
  resultFamily,
  logHistogram,
  type BucketResult,
} from '../data/aggregate';
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
  /** the plan a background sidecar fill is currently running for — dedupes
   *  overlapping fills and lets one abort when the plan changes */
  private metaFillPlan: ParsedKey[] | null = null;

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

  /**
   * Hydrate the rest of the operating range's sidecars in the background,
   * recent-first, after the eager (recent-horizon) slice has painted. Each
   * landed chunk bumps the store so the overview re-renders and the metadata
   * chart fills in. Deduped per plan; aborts when the plan changes.
   */
  startMetaFill(deferred: ParsedKey[]): void {
    // dedupe: one fill per plan. metaFillPlan stays pinned to the plan even
    // after it finishes, so the same selection is never re-filled with no-op
    // chunks; a plan change (new array) is what frees a fresh fill, and also
    // aborts this one via the keepGoing check.
    if (deferred.length === 0 || this.metaFillPlan === this.currentPlan) return;
    const plan = this.currentPlan;
    this.metaFillPlan = plan;
    // Each landed chunk re-renders the overview (which re-reads the ledger), so
    // throttle the intermediate notifications and always flush once at the end
    // — the ghost band still fills smoothly without hundreds of ledger scans.
    let lastNotify = 0;
    const notify = (): void => {
      const now = performance.now();
      if (now - lastNotify >= META_NOTIFY_MS) {
        lastNotify = now;
        this.store.markChanged();
      }
    };
    void hydrateSidecarsInBackground(this.bucket, deferred, notify, () => this.currentPlan === plan)
      .then(() => {
        if (this.currentPlan === plan) this.store.markChanged(); // final flush
      })
      .catch(() => {
        /* best-effort: a network error just leaves the tail to estimate/retry */
      });
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
 * Build the volume chart from the current selection's sidecar histograms.
 * Returns null when it can't (no plan/sidecars, or the resolved bucket is
 * sub-hourly) — the caller falls back to bucketByTime over loaded records.
 */
const CHART_HOUR_MS = 3_600_000;
/** Min gap between background-metadata-fill re-render notifications. */
const META_NOTIFY_MS = 500;
// Below this range span, the 1h metadata fallback isn't worth it — it'd be one
// or two coarse bars over-extending the brush — so go straight to the finer
// records-based bucket regardless of load state.
const MIN_METADATA_FALLBACK_MS = 2 * CHART_HOUR_MS;

/**
 * Whether every file overlapping the range is already loaded — so a sub-hour
 * (records-only) chart of that range would be complete, not partial or empty.
 * Used to gate auto-downgrading the bucket below the 1h metadata floor.
 */
function rangeFullyLoaded(s: Session, range: TimeRange): boolean {
  if (!range) return true;
  for (const f of s.currentPlan) {
    if (overlapsRange(f, range[0], range[1]) && !s.store.files.has(f.key)) return false;
  }
  return true;
}

/**
 * The time spans of intervals in the selection (currentPlan) whose files aren't
 * ALL loaded yet — used to blank partially-loaded buckets in the records-path
 * chart, so an interval is either fully populated or left blank, never partial.
 */
function incompleteSpans(s: Session): [number, number][] {
  const byInterval = new Map<string, { total: number; loaded: number }>();
  for (const f of s.currentPlan) {
    const e = byInterval.get(f.interval) ?? { total: 0, loaded: 0 };
    e.total++;
    if (s.store.files.has(f.key)) e.loaded++;
    byInterval.set(f.interval, e);
  }
  const spans: [number, number][] = [];
  for (const [interval, { total, loaded }] of byInterval) {
    if (loaded < total) {
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
 * scan is loading yet (so transitions don't flash an all-refused chart).
 */
function budgetRefusedSpans(s: Session): [number, number][] {
  const loaded = s.loader.planKeySet();
  if (loaded.size === 0) return [];
  const refused = new Set<string>();
  for (const f of s.currentPlan) {
    if (!loaded.has(f.key)) refused.add(f.interval);
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

/** The volume chart from sidecars, plus the unfilled (ghost) spans within the
 *  view whose sidecars haven't all been probed yet. */
interface MetaVolume {
  bucketed: BucketResult;
  unfilled: [number, number][];
}

async function metadataVolume(
  s: Session,
  range: TimeRange,
  bucketMs: number | null,
  utc: boolean,
): Promise<MetaVolume | null> {
  if (s.currentPlan.length === 0) return null;
  // Bound the blocking first paint: eagerly hydrate only the sidecars the
  // current view needs — the visible range, but no more than the recency
  // horizon back from its end (anchored to the latest interval present, so a
  // dormant bucket still shows its newest slice). The rest of the operating
  // range hydrates in the background, recent-first (startMetaFill), so a
  // yearlong selection paints now instead of stalling behind 10k GETs.
  const [earliestStart, latestEnd] = operatingRange(s);
  const winStart = range ? range[0] : earliestStart;
  const winEnd = range ? range[1] : latestEnd;
  const eagerStart = Math.max(winStart, winEnd - SIDECAR_PREFETCH_HORIZON_MS);
  const eager: ParsedKey[] = [];
  const deferred: ParsedKey[] = [];
  for (const f of s.currentPlan) {
    (overlapsRange(f, eagerStart, winEnd) ? eager : deferred).push(f);
  }
  await hydrateSidecars(s.bucket, eager); // one-time per file; cheap after
  s.startMetaFill(deferred); // fill the rest of the operating range in the background
  const byId = new Map((await ledgerRecords(s.bucket.bucket)).map((r) => [r.id, r]));

  // Group the in-view selection by interval. An interval's bar is drawn only
  // when ALL its files' sidecars have been probed (sidecarChecked) — a
  // partially-probed interval would undercount, a misleadingly short bar — so
  // those become *unfilled* ghost spans (SPEC §7) that fill in as the
  // background hydration reaches them.
  const byInterval = new Map<
    string,
    { checked: number; total: number; hists: Record<string, Record<string, number>>[] }
  >();
  for (const f of s.currentPlan) {
    if (!overlapsRange(f, winStart, winEnd)) continue; // outside the view
    const rec = byId.get(s.bucket.bucket + SEP + f.key);
    const e = byInterval.get(f.interval) ?? { checked: 0, total: 0, hists: [] };
    e.total++;
    if (rec?.sidecarChecked) {
      e.checked++;
      if (rec.intervals) e.hists.push(rec.intervals);
    }
    byInterval.set(f.interval, e);
  }

  const hists: Record<string, Record<string, number>>[] = [];
  const unfilledIntervals: [number, number][] = [];
  for (const [interval, e] of byInterval) {
    if (e.checked === e.total) {
      hists.push(...e.hists); // fully probed — its bar is accurate
    } else {
      const span = intervalSpan(interval);
      if (span) unfilledIntervals.push(span);
    }
  }

  // Nothing to show and nothing pending (e.g. a sidecarless bucket) → fall back
  // to the records path. Otherwise stay on the metadata path even with zero
  // histograms so far: the ghost band covers the whole intended range from
  // first paint and bars fill in as the background hydration lands.
  if (hists.length === 0 && unfilledIntervals.length === 0) return null;

  // domain = the intended view (the range, or the whole operating range) so
  // the chart spans the full range and the ghost band has room to render even
  // where no sidecar has landed yet
  const bucketed = bucketBySidecar(hists, range ?? [earliestStart, latestEnd], bucketMs, utc);
  if (!bucketed) return null; // sub-hourly: hourly histograms can't resolve it
  return { bucketed, unfilled: mergeSpans(unfilledIntervals, winStart, winEnd) };
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
  executeScan: (s, a) => {
    // a channel/range change is a *new plan*: reset the working-set loader to
    // the executed plan (possibly a memory-clamped subset of the selection)
    if ('range' in a) s.currentRange = (a.range as TimeRange) ?? null;
    s.loader.reset((a.plan as ScanPlan).files);
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
  overviewData: async (s, a) => {
    const range = a.range as TimeRange;
    let bucketMs = a.bucketMs as number | null;
    const utc = a.utc !== false; // align the bucket grid to the active display zone
    const txns = s.store.kindRecords('transaction');

    // Data-aware auto bucketing: a sub-hour bucket can only come from loaded
    // records, so don't *automatically* drop below the 1h metadata floor for a
    // range whose records aren't all in yet — that would render empty. Hold at
    // 1h (complete, from metadata) and let it refine to the finer bucket once
    // the range's records finish loading. An explicit choice (bucketMs set) is
    // always honored — the user waits for it the old-fashioned way.
    if (bucketMs === null && range) {
      const span = Math.max(range[1] - range[0], 1);
      const natural = chooseBucketMs(span);
      if (
        natural < CHART_HOUR_MS &&
        span >= MIN_METADATA_FALLBACK_MS &&
        !rangeFullyLoaded(s, range)
      ) {
        bucketMs = CHART_HOUR_MS;
      }
    }

    // The Volume chart is record COUNTS bucketed by time — exactly what the
    // sidecar histograms hold (hourly). So for any bucket ≥1h serve it from
    // metadata: instant, complete (all selected files), and works even when
    // the records aren't loaded (or are too big to load). Sub-hour buckets
    // fall back to the records path. The transaction table stays records-based.
    const meta = await metadataVolume(s, range, bucketMs, utc);
    let bucketed: BucketResult;
    let fromMetadata: boolean;
    // ghostSpans: where the working set is unfulfilled within the view (SPEC
    // §7) — the union of the metadata path's not-yet-probed intervals
    // (momentary) and the budget-refused intervals (persistent). Merged +
    // clipped to the drawn domain.
    const refused = budgetRefusedSpans(s);
    let ghostSpans: [number, number][];
    if (meta) {
      bucketed = meta.bucketed;
      fromMetadata = true;
      ghostSpans = mergeSpans([...meta.unfilled, ...refused], bucketed.domain[0], bucketed.domain[1]);
    } else {
      // records path: blank any interval still missing files, so a bucket is
      // fully populated or blank — never a misleadingly short partial bar
      bucketed = blankPartialBuckets(
        bucketByTime(s.store.records, range, bucketMs, utc),
        incompleteSpans(s),
      );
      fromMetadata = false;
      ghostSpans = mergeSpans(refused, bucketed.domain[0], bucketed.domain[1]);
    }

    return {
      bucketed,
      fromMetadata,
      ghostSpans,
      groups: groupTransactions(txns, range),
      inRange: (() => {
        const [lo, hi] = windowBounds(s.store.records, range);
        return hi - lo;
      })(),
      markers: deploymentMarkers(s.store.records),
    };
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
    const pool = windowSlice(s.store.records, a.range as TimeRange);
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
    const pool = windowSlice(
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
