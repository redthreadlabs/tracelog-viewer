/**
 * Trace assembly for the waterfall (SPEC §6.3). Pure logic: collect the
 * records of one trace_id, arrange spans into parent/child order (DFS,
 * children by start time), and interleave trace-correlated events and
 * errors as point markers. Works identically for server traces and for
 * client perf-timer traces (which arrive as transaction+span records).
 */
import type { Rec } from './types';

export interface TraceRow {
  rec: Rec;
  /** 0 = the transaction; spans nest beneath their parents */
  depth: number;
  /** epoch-ms */
  start: number;
  /** epoch-ms; equals start for point records (events, errors) */
  end: number;
}

export interface TraceModel {
  traceId: string;
  root: Rec | null;
  rows: TraceRow[];
  /** trace bounds, epoch-ms */
  t0: number;
  t1: number;
}

export function assembleTrace(records: Rec[], traceId: string): TraceModel {
  const members = records.filter((r) => r.traceId === traceId);

  const transactions = members
    .filter((r) => r.kind === 'transaction')
    .sort((a, b) => a.ts - b.ts);
  const root = transactions[0] ?? null;
  const rootId = root ? str(root.raw.id) : undefined;

  const spans = members.filter((r) => r.kind === 'span').sort((a, b) => a.ts - b.ts);
  const points = members
    .filter((r) => r.kind === 'event' || r.kind === 'error')
    .sort((a, b) => a.ts - b.ts);

  // span id → children, parented via raw.parent_id
  const byParent = new Map<string, Rec[]>();
  const spanIds = new Set(spans.map((s) => str(s.raw.id)).filter(Boolean) as string[]);
  const orphans: Rec[] = [];
  for (const span of spans) {
    const parentId = str(span.raw.parent_id);
    if (parentId && (spanIds.has(parentId) || parentId === rootId)) {
      const list = byParent.get(parentId) ?? [];
      list.push(span);
      byParent.set(parentId, list);
    } else {
      orphans.push(span); // parent not in the scanned data — show at depth 1
    }
  }

  const rows: TraceRow[] = [];
  if (root) {
    rows.push(toRow(root, 0));
  }

  const visited = new Set<string>();
  function walk(parentId: string, depth: number): void {
    for (const span of byParent.get(parentId) ?? []) {
      const id = str(span.raw.id);
      if (id && visited.has(id)) continue;
      if (id) visited.add(id);
      rows.push(toRow(span, depth));
      if (id) walk(id, depth + 1);
    }
  }
  if (rootId) walk(rootId, 1);
  for (const orphan of orphans) {
    const id = str(orphan.raw.id);
    if (id && visited.has(id)) continue;
    if (id) visited.add(id);
    rows.push(toRow(orphan, 1));
    if (id) walk(id, 2);
  }
  // any remaining (e.g. parented to a missing mid-chain span)
  for (const span of spans) {
    const id = str(span.raw.id);
    if (id && !visited.has(id)) {
      rows.push(toRow(span, 1));
    }
  }

  for (const point of points) {
    rows.push(toRow(point, 1));
  }

  // overall bounds
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const row of rows) {
    if (row.start > 0 && row.start < t0) t0 = row.start;
    if (row.end > t1) t1 = row.end;
  }
  if (!isFinite(t0)) {
    t0 = 0;
    t1 = 0;
  }

  return { traceId, root, rows, t0, t1 };
}

function toRow(rec: Rec, depth: number): TraceRow {
  return {
    rec,
    depth,
    start: rec.ts,
    end: rec.ts + (rec.kind === 'transaction' || rec.kind === 'span' ? (rec.duration ?? 0) : 0),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Map a span record's type/subtype onto the fixed span-type palette token. */
export function spanTypeToken(rec: Rec): string {
  if (rec.kind === 'transaction') return '--kind-transaction';
  if (rec.kind === 'event') return '--kind-event';
  if (rec.kind === 'error') return '--kind-error';
  const type = typeof rec.raw.type === 'string' ? rec.raw.type : '';
  const subtype = typeof rec.raw.subtype === 'string' ? rec.raw.subtype : '';
  if (type === 'db') {
    if (subtype === 'mongodb') return '--spantype-db-mongodb';
    if (subtype === 'redis') return '--spantype-db-redis';
    return '--spantype-db';
  }
  if (type === 'storage') return '--spantype-storage';
  if (type === 'external' || type === 'http') return '--spantype-external';
  if (type === 'app' || type === 'custom' || type === 'client-perf') return '--spantype-app';
  return '--spantype-other';
}
