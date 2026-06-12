/**
 * Metric extraction for the metrics view (SPEC §6.5). Pure logic:
 * runtime sample timeseries per host, deployment markers derived from
 * service.version changes, and breakdown self-time aggregation.
 */
import type { Rec } from './types';
import { resolveBucketMs } from './aggregate';

export interface SeriesPoint {
  t: number;
  v: number;
}

/** One series per host for a given metricset sample name, time-ordered. */
export function runtimeSeries(
  records: Rec[],
  sampleName: string,
  window?: [number, number] | null,
): Map<string, SeriesPoint[]> {
  const byHost = new Map<string, SeriesPoint[]>();
  for (const r of records) {
    if (r.kind !== 'metricset' || r.ts <= 0) continue;
    if (window && (r.ts < window[0] || r.ts > window[1])) continue;
    const value = r.samples?.[sampleName];
    if (value === undefined) continue;
    let series = byHost.get(r.host);
    if (!series) {
      series = [];
      byHost.set(r.host, series);
    }
    series.push({ t: r.ts, v: value });
  }
  for (const series of byHost.values()) series.sort((a, b) => a.t - b.t);
  return byHost;
}

export interface DeploymentMarker {
  t: number;
  version: string;
}

/**
 * Deployment markers: the first time each new service.version is seen in
 * the data (the initial version gets no marker — it was already running).
 */
export function deploymentMarkers(records: Rec[]): DeploymentMarker[] {
  const firstSeen = new Map<string, number>();
  for (const r of records) {
    const version = r.meta.serviceVersion;
    if (!version || r.ts <= 0) continue;
    const prev = firstSeen.get(version);
    if (prev === undefined || r.ts < prev) firstSeen.set(version, r.ts);
  }
  const ordered = [...firstSeen.entries()]
    .map(([version, t]) => ({ version, t }))
    .sort((a, b) => a.t - b.t);
  return ordered.slice(1); // drop the baseline version
}

export interface BreakdownBucket {
  t0: number;
  /** span `type/subtype` → summed self time (ms) */
  byType: Map<string, number>;
}

export interface BreakdownResult {
  buckets: BreakdownBucket[];
  bucketMs: number;
  types: string[];
}

/** Aggregate `span.self_time.sum.us` breakdown metricsets into time buckets. */
export function breakdownSelfTime(
  records: Rec[],
  window?: [number, number] | null,
  chosenBucketMs: number | null = null,
): BreakdownResult {
  interface Sample {
    t: number;
    key: string;
    ms: number;
  }
  const samples: Sample[] = [];
  for (const r of records) {
    if (r.kind !== 'metricset' || r.ts <= 0) continue;
    if (window && (r.ts < window[0] || r.ts > window[1])) continue;
    // breakdown metricsets carry their span attribution in rec.result
    if (!r.result) continue;
    const us = r.samples?.['span.self_time.sum.us'];
    if (us === undefined) continue;
    samples.push({ t: r.ts, key: r.result, ms: us / 1000 });
  }
  if (samples.length === 0) return { buckets: [], bucketMs: 60_000, types: [] };

  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (s.t < min) min = s.t;
    if (s.t > max) max = s.t;
  }
  const bucketMs = resolveBucketMs(Math.max(max - min, 1), chosenBucketMs);
  const start = Math.floor(min / bucketMs) * bucketMs;
  const n = Math.floor((max - start) / bucketMs) + 1;
  const buckets: BreakdownBucket[] = Array.from({ length: n }, (_, i) => ({
    t0: start + i * bucketMs,
    byType: new Map(),
  }));

  const totals = new Map<string, number>();
  for (const s of samples) {
    const bucket = buckets[Math.floor((s.t - start) / bucketMs)];
    bucket.byType.set(s.key, (bucket.byType.get(s.key) ?? 0) + s.ms);
    totals.set(s.key, (totals.get(s.key) ?? 0) + s.ms);
  }
  const types = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return { buckets, bucketMs, types };
}
