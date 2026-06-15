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

export type AggOp = 'count' | 'sum' | 'min' | 'max' | 'avg';

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
   *  onto the file's host/channel/… value. */
  points(payload: P, q: IndexQuery, file: FileFacets): WeightedPoint[];
}

/** Transaction COUNT + Σ duration, grouped by transaction name, hourly. Because
 *  each file is one host on one channel, the same payload also answers the same
 *  metrics grouped by host or channel — by collapsing all names onto the file's
 *  value (`fileGroupBy`), no extra storage. */
export const txnIndex: AggregateIndex<TxnFileIndex> = {
  name: 'txn',
  capability: {
    provides: [{ op: 'count' }, { op: 'sum', field: 'duration' }],
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
    return txnIndexPoints(payload, q.op === 'sum' ? 'sum' : 'count', q.from, q.to, q.show, fixedKey);
  },
};

export const INDEXES: AggregateIndex[] = [txnIndex];

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
