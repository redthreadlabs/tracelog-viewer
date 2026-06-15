/**
 * The aggregate-query contract (SPEC §11), UI side.
 *
 * DELIBERATELY DUPLICATED with `src/worker/query.ts`. This is the first draft of
 * the contract between the UI and the worker; while it is still finding its
 * shape we keep two copies that evolve independently rather than prematurely
 * extracting a shared module (the worker is destined to become its own library,
 * at which point this becomes a real wire contract). Keep the two files in sync
 * by hand until then.
 */

/** An aggregate to tally. The field is required for everything but count;
 *  groupBy breaks the tally out by a dimension (omit for a single total). */
export type AggOp = 'count' | 'sum' | 'min' | 'max' | 'avg';

export interface Metric {
  op: AggOp;
  /** numeric field to aggregate (e.g. 'duration') — omit for `count` */
  field?: string;
  /** dimension to break out (e.g. 'kind', 'transaction') — omit for a total */
  groupBy?: string;
}
