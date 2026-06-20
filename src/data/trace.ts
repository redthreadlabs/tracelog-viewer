/**
 * Trace assembly for the waterfall (SPEC §6.3). Pure logic: collect the
 * records of one trace_id, arrange spans into parent/child order (DFS,
 * children by start time), and interleave trace-correlated events and
 * errors as point markers. Works identically for server traces and for
 * client perf traces (which arrive as transaction+span records).
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

  // Tree nodes are transactions + spans. A trace can hold MORE than one
  // transaction: a distributed trace nests a downstream service's transaction
  // under the caller's exit span (its parent_id is that span's id), all sharing
  // the trace_id. So we build a general parent_id forest over both kinds rather
  // than assuming a single root transaction with a flat span tree.
  const nodes = members.filter((r) => r.kind === 'transaction' || r.kind === 'span');
  const byId = new Map<string, Rec>();
  for (const n of nodes) if (n.selfId) byId.set(n.selfId, n);

  // parent selfId → child nodes (spans/transactions AND point records). Folding
  // events/errors into the same forest lets the DFS interleave them with sibling
  // spans by start time, instead of appending them all at the end of the trace.
  const byParent = new Map<string, Rec[]>();
  const roots: Rec[] = [];
  const orphanPoints: Rec[] = [];
  const addChild = (parentId: string, child: Rec): void => {
    const list = byParent.get(parentId);
    if (list) list.push(child);
    else byParent.set(parentId, [child]);
  };
  for (const n of nodes) {
    const parentId = n.parentId;
    if (parentId && byId.has(parentId)) {
      addChild(parentId, n);
    } else if (n.kind === 'transaction') {
      // the trace entry point, or a downstream txn whose caller isn't loaded
      roots.push(n);
    }
    // a span whose parent isn't in the trace falls to the orphan sweep below
  }
  // events/errors are point children of their span/transaction (by parent_id,
  // else transaction_id); those with no in-trace parent go to the orphan sweep.
  for (const r of members) {
    if (r.kind !== 'event' && r.kind !== 'error') continue;
    const pid =
      r.parentId !== undefined && byId.has(r.parentId) ? r.parentId :
      r.transactionId !== undefined && byId.has(r.transactionId) ? r.transactionId :
      undefined;
    if (pid !== undefined) addChild(pid, r);
    else orphanPoints.push(r);
  }
  // children (spans + points together) in start-time order — the interleave
  for (const list of byParent.values()) list.sort((a, b) => a.ts - b.ts);
  roots.sort((a, b) => a.ts - b.ts);
  const root = roots[0] ?? null;

  const rows: TraceRow[] = [];
  const visited = new Set<string>();
  function walk(node: Rec, depth: number): void {
    const id = node.selfId;
    if (id) {
      if (visited.has(id)) return;
      visited.add(id);
    }
    rows.push(toRow(node, depth));
    if (id) for (const child of byParent.get(id) ?? []) walk(child, depth + 1);
  }
  for (const r of roots) walk(r, 0);
  // orphan spans (parent not in the trace) + their point children → depth 1
  for (const n of nodes) if (n.selfId && !visited.has(n.selfId)) walk(n, 1);
  // events/errors whose parent isn't in the trace at all → depth 1, in ts order
  orphanPoints.sort((a, b) => a.ts - b.ts);
  for (const p of orphanPoints) rows.push(toRow(p, 1));

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
