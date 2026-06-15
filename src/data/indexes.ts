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
  /** the dimension it is grouped by, e.g. 'transaction' */
  groupBy: string;
  /** rollup granularity; the solver rolls finer→coarser, never the reverse */
  granularityMs: number;
  /** decomposability over interval-merge (SPEC §11.2) */
  merge: 'distributive' | 'algebraic' | 'holistic';
}

export interface StoredIndex<P> {
  etag?: string;
  payload: P;
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
  /** pre-aggregated points for a query over [from, to) (distributive merge) */
  points(
    payload: P,
    op: AggOp,
    field: string | undefined,
    from: number,
    to: number,
    show?: Set<string>,
  ): WeightedPoint[];
}

/** Transaction COUNT + Σ duration, grouped by transaction name, hourly. */
export const txnIndex: AggregateIndex<TxnFileIndex> = {
  name: 'txn',
  capability: {
    provides: [{ op: 'count' }, { op: 'sum', field: 'duration' }],
    groupBy: 'transaction',
    granularityMs: 3_600_000, // hourly
    merge: 'distributive',
  },
  build: buildTxnIndex,
  persist: putTxnIndex,
  load: async (bucket) =>
    new Map(
      (await txnIndexRecords(bucket)).map((r) => [r.id, { etag: r.etag, payload: r.index }]),
    ),
  points: (payload, op, _field, from, to, show) =>
    txnIndexPoints(payload, op === 'sum' ? 'sum' : 'count', from, to, show),
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
    const granularityOk =
      bucketMs >= c.granularityMs &&
      bucketMs % c.granularityMs === 0 &&
      gridStart % c.granularityMs === 0;
    return opOk && c.groupBy === groupBy && c.merge === 'distributive' && granularityOk;
  });
}
