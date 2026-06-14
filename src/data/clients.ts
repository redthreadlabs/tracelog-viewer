/**
 * Client analytics (SPEC §6.6): client-originated records cut by user and
 * device. Selection is content-based — a record "comes from a client" when
 * it carries client identity (device / OS / app version from
 * `event.client.*`) — with a channel conventionally named `client` honored
 * as a secondary hint for deployments whose older clients sent no identity.
 * Channel names are deployment-specific; content is the contract (§3.2).
 * Pure logic.
 */
import type { Rec } from './types';
import { rangeSlice } from './store';

/** A gap longer than this splits a user's events into separate sessions. */
export const SESSION_GAP_MS = 15 * 60_000;

/** Client perf threshold — events at/above this duration are "slow". */
export const SLOW_EVENT_MS = 100;

export interface ClientProfile {
  userId: string;
  events: number;
  errors: number;
  sessions: number;
  firstTs: number;
  lastTs: number;
  device?: string;
  os?: string;
  appVersions: string[];
}

/** Content first, conventional channel name as a courtesy. */
export function isClientRec(r: Rec): boolean {
  return (
    (r.kind === 'event' || r.kind === 'error') &&
    (r.device !== undefined ||
      r.os !== undefined ||
      r.appVersion !== undefined ||
      r.channel === 'client')
  );
}

function clientEvents(records: Rec[], range?: [number, number] | null): Rec[] {
  return rangeSlice(records, range).filter((r) => isClientRec(r) && r.ts > 0);
}

export function clientProfiles(
  records: Rec[],
  range?: [number, number] | null,
): ClientProfile[] {
  const byUser = new Map<string, Rec[]>();
  for (const r of clientEvents(records, range)) {
    const user = r.userId ?? '(anonymous)';
    const list = byUser.get(user) ?? [];
    list.push(r);
    byUser.set(user, list);
  }

  const profiles: ClientProfile[] = [];
  for (const [userId, recs] of byUser) {
    recs.sort((a, b) => a.ts - b.ts);
    let sessions = 1;
    for (let i = 1; i < recs.length; i++) {
      if (recs[i].ts - recs[i - 1].ts > SESSION_GAP_MS) sessions++;
    }
    const versions = new Set<string>();
    let device: string | undefined;
    let os: string | undefined;
    for (const r of recs) {
      if (r.appVersion) versions.add(r.appVersion);
      if (!device && r.device) device = r.device;
      if (!os && r.os) os = r.os;
    }
    profiles.push({
      userId,
      events: recs.length,
      errors: recs.filter((r) => r.kind === 'error' || r.level === 'error').length,
      sessions,
      firstTs: recs[0].ts,
      lastTs: recs[recs.length - 1].ts,
      device,
      os,
      appVersions: [...versions].sort(),
    });
  }

  return profiles.sort((a, b) => b.events - a.events);
}

export interface AppVersionStat {
  version: string;
  users: number;
  events: number;
}

export function appVersions(
  records: Rec[],
  range?: [number, number] | null,
): AppVersionStat[] {
  const byVersion = new Map<string, { users: Set<string>; events: number }>();
  for (const r of clientEvents(records, range)) {
    const version = r.appVersion;
    if (!version) continue;
    let stat = byVersion.get(version);
    if (!stat) {
      stat = { users: new Set(), events: 0 };
      byVersion.set(version, stat);
    }
    stat.users.add(r.userId ?? '(anonymous)');
    stat.events++;
  }
  return [...byVersion.entries()]
    .map(([version, s]) => ({ version, users: s.users.size, events: s.events }))
    .sort((a, b) => b.users - a.users || b.events - a.events);
}

/** Client events at/above the slow threshold, slowest first. */
export function slowClientEvents(
  records: Rec[],
  range?: [number, number] | null,
  thresholdMs = SLOW_EVENT_MS,
): Rec[] {
  return clientEvents(records, range)
    .filter((r) => r.duration !== undefined && r.duration >= thresholdMs)
    .sort((a, b) => b.duration! - a.duration!);
}

export interface EventTypeStat {
  type: string;
  count: number;
  users: number;
}

/** Client event types by volume — the generic funnel raw material. */
export function clientEventTypes(
  records: Rec[],
  range?: [number, number] | null,
): EventTypeStat[] {
  const byType = new Map<string, { count: number; users: Set<string> }>();
  for (const r of clientEvents(records, range)) {
    let stat = byType.get(r.name);
    if (!stat) {
      stat = { count: 0, users: new Set() };
      byType.set(r.name, stat);
    }
    stat.count++;
    stat.users.add(r.userId ?? '(anonymous)');
  }
  return [...byType.entries()]
    .map(([type, s]) => ({ type, count: s.count, users: s.users.size }))
    .sort((a, b) => b.count - a.count);
}
