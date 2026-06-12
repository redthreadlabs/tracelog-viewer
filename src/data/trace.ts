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
  const rootId = root?.selfId;

  const spans = members.filter((r) => r.kind === 'span').sort((a, b) => a.ts - b.ts);
  const points = members
    .filter((r) => r.kind === 'event' || r.kind === 'error')
    .sort((a, b) => a.ts - b.ts);

  // span id → children, parented via parent_id
  const byParent = new Map<string, Rec[]>();
  const spanIds = new Set(spans.map((s) => s.selfId).filter(Boolean) as string[]);
  const orphans: Rec[] = [];
  for (const span of spans) {
    const parentId = span.parentId;
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
      const id = span.selfId;
      if (id && visited.has(id)) continue;
      if (id) visited.add(id);
      rows.push(toRow(span, depth));
      if (id) walk(id, depth + 1);
    }
  }
  if (rootId) walk(rootId, 1);
  for (const orphan of orphans) {
    const id = orphan.selfId;
    if (id && visited.has(id)) continue;
    if (id) visited.add(id);
    rows.push(toRow(orphan, 1));
    if (id) walk(id, 2);
  }
  // any remaining (e.g. parented to a missing mid-chain span)
  for (const span of spans) {
    const id = span.selfId;
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

/** Fixed span-type palette: `type/subtype` key → CSS token (SPEC §7). */
const TYPE_TOKEN_MAP: [RegExp, string][] = [
  [/^db\/mongodb$/, '--spantype-db-mongodb'],
  [/^db\/redis$/, '--spantype-db-redis'],
  [/^db\b/, '--spantype-db'],
  [/^storage\b/, '--spantype-storage'],
  [/^(external|http)\b/, '--spantype-external'],
  [/^(app|custom|client-perf)\b/, '--spantype-app'],
];

export function spanTypeColorToken(key: string): string {
  for (const [re, token] of TYPE_TOKEN_MAP) {
    if (re.test(key)) return token;
  }
  return '--spantype-other';
}

/** Map a record onto the palette: spans by their `type/subtype` result. */
export function spanTypeToken(rec: Rec): string {
  if (rec.kind === 'transaction') return '--kind-transaction';
  if (rec.kind === 'event') return '--kind-event';
  if (rec.kind === 'error') return '--kind-error';
  return spanTypeColorToken(rec.result ?? '');
}
