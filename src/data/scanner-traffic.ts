/**
 * Scanner traffic (SPEC §6.7): internet background noise probing the public
 * endpoint. Selection is content-based: Elastic-lineage agents name a
 * transaction that matched no route `<METHOD> unknown route`, so that name
 * is the contract in every deployment; a channel conventionally named
 * `unknown-route` (deployments that divert the noise at write time) is
 * honored as a secondary hint. Deliberately small. Pure logic.
 */
import type { Rec } from './types';
import { windowSlice } from './store';

const UNKNOWN_ROUTE = /^[A-Z]+ unknown route$/;

export function isScannerRec(r: Rec): boolean {
  return (
    r.kind === 'transaction' &&
    (UNKNOWN_ROUTE.test(r.name ?? '') || r.channel === 'unknown-route')
  );
}

export interface RankedCount {
  key: string;
  count: number;
}

export interface ScannerStats {
  total: number;
  perDay: { day: string; count: number }[];
  topPaths: RankedCount[];
  topAgents: RankedCount[];
  topIps: RankedCount[];
}

export function scannerStats(
  records: Rec[],
  window?: [number, number] | null,
  topN = 15,
): ScannerStats {
  const probes = windowSlice(records, window).filter((r) => isScannerRec(r) && r.ts > 0);

  const perDayMap = new Map<string, number>();
  const paths = new Map<string, number>();
  const agents = new Map<string, number>();
  const ips = new Map<string, number>();

  for (const r of probes) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    perDayMap.set(day, (perDayMap.get(day) ?? 0) + 1);
    if (r.path) paths.set(r.path, (paths.get(r.path) ?? 0) + 1);
    if (r.agent) agents.set(r.agent, (agents.get(r.agent) ?? 0) + 1);
    if (r.ip) ips.set(r.ip, (ips.get(r.ip) ?? 0) + 1);
  }

  const rank = (m: Map<string, number>): RankedCount[] =>
    [...m.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);

  return {
    total: probes.length,
    perDay: [...perDayMap.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    topPaths: rank(paths),
    topAgents: rank(agents),
    topIps: rank(ips),
  };
}
