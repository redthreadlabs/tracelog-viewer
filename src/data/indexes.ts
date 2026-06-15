/**
 * The aggregate-index registry (SPEC §11). Each index is a self-contained
 * *declaration* — what it can answer (its capability), how to build it at parse
 * time, how to persist/load it, and how to emit its rollups as points for the
 * solver. The solver matches a query's metric against the registry instead of
 * hard-coding which index serves what, so adding an index (by host, errors, …)
 * is a declaration here rather than a new branch in the solver.
 *
 * Today every index is `distributive` (its stored weights simply sum across
 * intervals — the WeightedPoint fast-path). Algebraic (avg = sum/count) and
 * holistic (p95 via sketches) merges are declared in the capability but not yet
 * matched; they need a richer contribution than a summed weight.
 */
import type { Rec } from './types';
import type { WeightedPoint } from './aggregate';
import {
  buildTxnIndex,
  putTxnIndex,
  txnIndexRecords,
  txnIndexPoints,
  type TxnFileIndex,
} from './txnindex';
import {
  buildDurHist,
  putDurHist,
  durHistRecords,
  DURHIST_BINS,
  type DurHistFileIndex,
} from './durhist';

/**
 * The exact-vs-estimated P95 threshold (SPEC §11.5): the most transactions the
 * solver will scan+sort for an EXACT P95 before serving the histogram ESTIMATE
 * instead. The decision is made up front from the cube's exact in-range count
 * (the cost driver of the exact pass) — no scan needed to decide. ~1M keeps the
 * exact pass well under ~100ms; above it the table is served entirely from the
 * cube + histogram (instant, P95 marked estimated). Tunable; surfaced on
 * /internals/indexing alongside the live count.
 */
export const TXN_EXACT_P95_MAX = 1_000_000;

export type AggOp = 'count' | 'sum' | 'min' | 'max' | 'avg' | 'p95';

/** One (op, field) aggregate an index answers. `count` ignores `field`. */
export interface AggregateSig {
  op: AggOp;
  field?: string;
}

/** What an index can satisfy — matched against a query's metric. */
export interface IndexCapability {
  /** the (op, field) pairs it answers directly */
  provides: AggregateSig[];
  /** the dimension its payload is keyed by, e.g. 'transaction' */
  groupBy: string;
  /** file-HOMOGENEOUS attributes it can ALSO project onto for free: each file
   *  is constant in these (host, channel — they're in the S3 key), so summing
   *  the payload and keying by the file's value is exact, no per-record work.
   *  This is the seed of runtime query plans from the files' inherent shape. */
  fileGroupBy?: string[];
  /** rollup granularity; the solver rolls finer→coarser, never the reverse */
  granularityMs: number;
  /** decomposability over interval-merge (SPEC §11.2) */
  merge: 'distributive' | 'algebraic' | 'holistic';
}

export interface StoredIndex<P> {
  etag?: string;
  payload: P;
}

/** A query the index is asked to satisfy over [from, to). */
export interface IndexQuery {
  op: AggOp;
  field?: string;
  groupBy: string;
  from: number;
  to: number;
  /** group keys to include (transaction names, or hosts, … per groupBy) */
  show?: Set<string>;
}

/** The file-homogeneous attributes a file carries (from its S3 key) — what a
 *  file-level `groupBy` projects onto. */
export interface FileFacets {
  key: string;
  host: string;
  channel: string;
  interval: string;
}

export interface AggregateIndex<P = unknown> {
  readonly name: string;
  readonly capability: IndexCapability;
  /** parse-time: roll a file's records into the stored payload (pure) */
  build(records: Rec[]): P;
  /** persist a file's payload, keyed by file + ETag */
  persist(bucket: string, key: string, etag: string | undefined, payload: P): Promise<void>;
  /** every stored payload for a bucket, by file id (`${bucket}\0${key}`) */
  load(bucket: string): Promise<Map<string, StoredIndex<P>>>;
  /** pre-aggregated points for the query, from one file's payload + its facets
   *  (distributive merge). `file` lets a file-level groupBy collapse the payload
   *  onto the file's host/channel/… value. Distributive indexes only; holistic
   *  ones (merge !== 'distributive') are served by a future merge path, not this. */
  points?(payload: P, q: IndexQuery, file: FileFacets): WeightedPoint[];
  /** optional metrics for the /internals/indexing page (e.g. bin occupancy) */
  stats?(payloads: P[]): Record<string, unknown>;
}

/** Transaction COUNT + Σ duration, grouped by transaction name, hourly. Because
 *  each file is one host on one channel, the same payload also answers the same
 *  metrics grouped by host or channel — by collapsing all names onto the file's
 *  value (`fileGroupBy`), no extra storage. */
export const txnIndex: AggregateIndex<TxnFileIndex> = {
  name: 'txn',
  capability: {
    // sum(errors) totals the per-cell bad-result counter — distributive, like count
    provides: [{ op: 'count' }, { op: 'sum', field: 'duration' }, { op: 'sum', field: 'errors' }],
    groupBy: 'transaction',
    fileGroupBy: ['host', 'channel'],
    granularityMs: 3_600_000, // hourly
    merge: 'distributive',
  },
  build: buildTxnIndex,
  persist: putTxnIndex,
  load: async (bucket) =>
    new Map(
      (await txnIndexRecords(bucket)).map((r) => [r.id, { etag: r.etag, payload: r.index }]),
    ),
  points: (payload, q, file) => {
    // a file-level groupBy (host/channel) collapses the whole file onto its
    // value; the native groupBy (transaction) keeps per-name points
    const fixedKey =
      q.groupBy in file ? (file as unknown as Record<string, string>)[q.groupBy] : undefined;
    return txnIndexPoints(
      payload,
      q.op === 'sum' ? 'sum' : 'count',
      q.field,
      q.from,
      q.to,
      q.show,
      fixedKey,
    );
  },
  stats: (payloads) => {
    let cells = 0;
    const names = new Set<string>();
    for (const p of payloads)
      for (const hour in p)
        for (const name in p[hour]) {
          cells++;
          names.add(name);
        }
    return { cells, distinctNames: names.size };
  },
};

/** Per-(hour, transaction) duration histogram — the holistic P95 sketch.
 *  Registered so it builds + persists at parse time; the solver doesn't query it
 *  yet (matchIndex serves only distributive metrics — the holistic merge path is
 *  the next step), so it has no `points`. */
export const durHistIndex: AggregateIndex<DurHistFileIndex> = {
  name: 'durhist',
  capability: {
    provides: [{ op: 'p95', field: 'duration' }],
    groupBy: 'transaction',
    fileGroupBy: ['host', 'channel'],
    granularityMs: 3_600_000,
    merge: 'holistic',
  },
  build: buildDurHist,
  persist: putDurHist,
  load: async (bucket) =>
    new Map((await durHistRecords(bucket)).map((r) => [r.id, { etag: r.etag, payload: r.index }])),
  stats: (payloads) => {
    const perBin: Record<string, number> = {};
    let cells = 0;
    for (const p of payloads)
      for (const hour in p)
        for (const name in p[hour]) {
          cells++;
          const bins = p[hour][name];
          for (const b in bins) perBin[b] = (perBin[b] ?? 0) + bins[b];
        }
    const used = Object.keys(perBin)
      .map(Number)
      .sort((a, b) => a - b);
    return {
      cells,
      binsPopulated: used.length, // how many of the 43 bins are actually used
      binsTotal: DURHIST_BINS,
      binRange: used.length ? [used[0], used[used.length - 1]] : null,
      perBin, // bin index → total duration count (occupancy)
    };
  },
};

export const INDEXES: AggregateIndex[] = [txnIndex, durHistIndex];

/**
 * The first registered index that can satisfy the metric at this bucket grid:
 * it provides the (op, field), is grouped by the same dimension, merges
 * distributively, and its granularity divides the (hour-or-coarser, aligned)
 * grid. Undefined → no index applies; the caller scans records.
 */
export function matchIndex(
  op: AggOp,
  field: string | undefined,
  groupBy: string | undefined,
  bucketMs: number,
  gridStart: number,
): AggregateIndex | undefined {
  return INDEXES.find((ix) => {
    const c = ix.capability;
    const opOk = c.provides.some((p) => p.op === op && (op === 'count' || p.field === field));
    const groupOk = c.groupBy === groupBy || (c.fileGroupBy?.includes(groupBy ?? '') ?? false);
    const granularityOk =
      bucketMs >= c.granularityMs &&
      bucketMs % c.granularityMs === 0 &&
      gridStart % c.granularityMs === 0;
    return opOk && groupOk && c.merge === 'distributive' && granularityOk;
  });
}
