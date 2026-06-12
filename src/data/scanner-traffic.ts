/**
 * Scanner traffic (SPEC §6.7): the unknown-route channel — internet
 * background noise hitting the public ALB. Deliberately small. Pure logic.
 */
import type { Rec } from './types';

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
  const probes = records.filter(
    (r) =>
      r.channel === 'unknown-route' &&
      r.kind === 'transaction' &&
      r.ts > 0 &&
      (!window || (r.ts >= window[0] && r.ts <= window[1])),
  );

  const perDayMap = new Map<string, number>();
  const paths = new Map<string, number>();
  const agents = new Map<string, number>();
  const ips = new Map<string, number>();

  for (const r of probes) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    perDayMap.set(day, (perDayMap.get(day) ?? 0) + 1);

    const context = r.raw.context as Record<string, unknown> | undefined;
    const request = context?.request as Record<string, unknown> | undefined;
    const url = request?.url as Record<string, unknown> | undefined;
    const headers = request?.headers as Record<string, unknown> | undefined;

    const path = typeof url?.pathname === 'string' ? url.pathname : undefined;
    if (path) paths.set(path, (paths.get(path) ?? 0) + 1);

    const agent = typeof headers?.['user-agent'] === 'string' ? headers['user-agent'] : undefined;
    if (agent) agents.set(agent, (agents.get(agent) ?? 0) + 1);

    const fwd = headers?.['x-forwarded-for'];
    const ip =
      typeof fwd === 'string'
        ? fwd.split(',')[0].trim()
        : ((request?.socket as Record<string, unknown> | undefined)?.remote_address as
            | string
            | undefined);
    if (ip) ips.set(ip, (ips.get(ip) ?? 0) + 1);
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
