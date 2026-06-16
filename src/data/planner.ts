/**
 * The batch planner (SPEC §11). Where the early solver answered one metric at a
 * time, this takes a SET of metrics over a single window and produces them all,
 * reading each index ONCE — so the overview's chart series and table totals,
 * which both derive from the transaction cube, come out of a single pass instead
 * of two independent solves.
 *
 * It groups the requested metrics by the source that serves them (the cube for
 * count/Σ; the duration sketch for P95), iterates each source once, and fans
 * every cell out to all the metrics that read it. Series-shaped metrics emit
 * pre-aggregated points (handed to `aggregateBySeries` for ranking/bucketing);
 * total-shaped metrics fold straight into a per-group tally.
 *
 * This is the index-served batch. A metric whose cheapest plan is a raw scan
 * (e.g. the drill-down's instances) is a `scan` source — classified here but
 * delivered by the deferred path, not this synchronous pass.
 */
import type { AggOp } from './indexes';
import {
  aggregateBySeries,
  type SeriesResult,
  type WeightedPoint,
} from './aggregate';
import { hourLabelToMs, HOUR_MS, type TxnFileIndex } from './txnindex';
import { mergeBins, quantileFromBins, type Bins, type DurHistFileIndex } from './durhist';

export type MetricShape = 'series' | 'total';

/** One metric the caller wants, labelled by `key` for result lookup. */
export interface MetricSpec {
  key: string;
  op: AggOp;
  /** numeric field — 'duration' | 'errors'; omit for count */
  field?: string;
  shape: MetricShape;
}

export type MetricSource = 'cube' | 'histogram' | 'scan' | null;

/** Which source serves a metric — the seam a real cost-based planner widens. */
export function sourceOf(m: MetricSpec): MetricSource {
  if (m.op === 'count') return 'cube';
  if (m.op === 'sum' && (m.field === 'duration' || m.field === 'errors')) return 'cube';
  if (m.op === 'p95' && m.field === 'duration') return 'histogram';
  return null;
}

export interface BatchInput {
  metrics: MetricSpec[];
  range: [number, number];
  bucketMs: number | null;
  utc: boolean;
  /** series group selection (chart legend); undefined → rank to top-N */
  show?: Set<string>;
  /** series: groups to keep before folding the tail (no "Other" here) */
  topN: number;
}

export interface BatchResult {
  /** series-shaped metrics, by key */
  series: Map<string, SeriesResult>;
  /** total-shaped metrics, by key → (group name → value) */
  totals: Map<string, Map<string, number>>;
}

/**
 * Solve the cube- and histogram-served metrics of a batch from already-loaded,
 * ETag-validated payloads (the worker hands in the in-range files). Pure — the
 * cube is iterated once for ALL its metrics, the histogram once for all of its.
 */
export function planIndexBatch(
  input: BatchInput,
  cubePayloads: TxnFileIndex[],
  histPayloads: DurHistFileIndex[],
): BatchResult {
  const { metrics, range, bucketMs, utc, show, topN } = input;
  const [from, to] = range;
  const inRange = (t: number | null): t is number => t !== null && t >= from && t + HOUR_MS <= to;

  const cubeMetrics = metrics.filter((m) => sourceOf(m) === 'cube');
  const histMetrics = metrics.filter((m) => sourceOf(m) === 'histogram');

  // per-key accumulators
  const seriesPoints = new Map<string, WeightedPoint[]>();
  const totals = new Map<string, Map<string, number>>();
  for (const m of metrics) {
    if (m.shape === 'series') seriesPoints.set(m.key, []);
    else totals.set(m.key, new Map());
  }

  // ---- cube: one pass, fan every cell to every cube metric ----
  const weigh = (cell: { c: number; d: number; e: number }, m: MetricSpec): number =>
    m.op === 'count' ? cell.c : m.field === 'errors' ? cell.e : cell.d;
  for (const payload of cubePayloads) {
    for (const label in payload) {
      const t = hourLabelToMs(label);
      if (!inRange(t)) continue; // whole-in-range hours only
      const byName = payload[label];
      for (const name in byName) {
        const cell = byName[name];
        for (const m of cubeMetrics) {
          const val = weigh(cell, m);
          if (val === 0) continue;
          if (m.shape === 'series') {
            if (show && !show.has(name)) continue; // chart shows only the selection
            seriesPoints.get(m.key)!.push({ name, t, weight: val });
          } else {
            const tally = totals.get(m.key)!;
            tally.set(name, (tally.get(name) ?? 0) + val);
          }
        }
      }
    }
  }

  // ---- histogram: one pass, merge bins per name, then read the quantile ----
  if (histMetrics.length > 0) {
    const binsByName = new Map<string, Bins>();
    for (const payload of histPayloads) {
      for (const label in payload) {
        const t = hourLabelToMs(label);
        if (!inRange(t)) continue;
        const byName = payload[label];
        for (const name in byName) {
          let into = binsByName.get(name);
          if (!into) binsByName.set(name, (into = {}));
          mergeBins(into, byName[name]);
        }
      }
    }
    for (const m of histMetrics) {
      // only p95(duration) for now; total-shaped (a series quantile would merge
      // per-bucket bins, a future extension)
      const tally = totals.get(m.key)!;
      for (const [name, bins] of binsByName) {
        const q = quantileFromBins(bins, 0.95);
        if (q !== undefined) tally.set(name, q);
      }
    }
  }

  // ---- assemble series via the shared ranker/bucketer (records empty: the
  // points carry everything; value/group/include are unused) ----
  const series = new Map<string, SeriesResult>();
  for (const m of metrics) {
    if (m.shape !== 'series') continue;
    series.set(
      m.key,
      aggregateBySeries(
        [],
        range,
        bucketMs,
        utc,
        { value: () => 0, group: () => '', topN, noOther: true },
        seriesPoints.get(m.key)!,
      ),
    );
  }

  return { series, totals };
}
