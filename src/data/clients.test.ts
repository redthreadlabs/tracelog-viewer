import { describe, it, expect } from 'vitest';
import { clientProfiles, appVersions, slowClientEvents, clientEventTypes } from './clients';
import { scannerStats } from './scanner-traffic';
import type { Rec } from './types';

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'event',
    ts: 1000,
    channel: 'client',
    host: 'h',
    sourceKey: 'k',
    meta: {},
    name: 'app',
    raw: {},
    ...partial,
  };
}

const MIN = 60_000;

describe('clientProfiles', () => {
  it('groups by user, splits sessions on >15 min gaps, collects device info', () => {
    const records = [
      rec({ userId: 'u1', ts: 1 * MIN, raw: { client: { version: '1.0.0', device: { model: 'iPhone 16 Pro' }, os: { name: 'iOS', version: '26.5' } } } }),
      rec({ userId: 'u1', ts: 5 * MIN }),
      rec({ userId: 'u1', ts: 30 * MIN }), // 25 min gap → new session
      rec({ userId: 'u1', ts: 31 * MIN, level: 'error' }),
      rec({ userId: 'u2', ts: 2 * MIN, raw: { client: { version: '1.1.0' } } }),
      rec({ userId: 'srv', ts: 3 * MIN, channel: 'server' }), // not client channel
    ];
    const profiles = clientProfiles(records);
    expect(profiles).toHaveLength(2);
    const u1 = profiles.find((p) => p.userId === 'u1')!;
    expect(u1.events).toBe(4);
    expect(u1.sessions).toBe(2);
    expect(u1.errors).toBe(1);
    expect(u1.device).toBe('iPhone 16 Pro');
    expect(u1.os).toBe('iOS 26.5');
    expect(u1.appVersions).toEqual(['1.0.0']);
  });

  it('buckets userless events as anonymous', () => {
    const profiles = clientProfiles([rec({ ts: MIN })]);
    expect(profiles[0].userId).toBe('(anonymous)');
  });
});

describe('appVersions', () => {
  it('counts users and events per version', () => {
    const records = [
      rec({ userId: 'u1', ts: MIN, raw: { client: { version: '1.0.0' } } }),
      rec({ userId: 'u2', ts: MIN, raw: { client: { version: '1.0.0' } } }),
      rec({ userId: 'u2', ts: 2 * MIN, raw: { client: { version: '1.0.0' } } }),
      rec({ userId: 'u3', ts: MIN, raw: { client: { version: '1.1.0' } } }),
    ];
    const versions = appVersions(records);
    expect(versions[0]).toEqual({ version: '1.0.0', users: 2, events: 3 });
    expect(versions[1]).toEqual({ version: '1.1.0', users: 1, events: 1 });
  });
});

describe('slowClientEvents', () => {
  it('returns client events ≥ threshold, slowest first', () => {
    const records = [
      rec({ ts: MIN, duration: 250, name: 'query:a' }),
      rec({ ts: MIN, duration: 99 }),
      rec({ ts: MIN, duration: 1200, name: 'query:b' }),
      rec({ ts: MIN, duration: 500, channel: 'server' }),
    ];
    const slow = slowClientEvents(records);
    expect(slow.map((r) => r.name)).toEqual(['query:b', 'query:a']);
  });
});

describe('clientEventTypes', () => {
  it('ranks types by volume with distinct users', () => {
    const records = [
      rec({ userId: 'u1', ts: MIN, name: 'review-queue' }),
      rec({ userId: 'u2', ts: MIN, name: 'review-queue' }),
      rec({ userId: 'u1', ts: MIN, name: 'onboarding' }),
    ];
    const types = clientEventTypes(records);
    expect(types[0]).toEqual({ type: 'review-queue', count: 2, users: 2 });
  });
});

describe('scannerStats', () => {
  it('aggregates probes per day, top paths/agents/ips', () => {
    const probe = (ts: number, path: string, agent: string, ip: string) =>
      rec({
        kind: 'transaction',
        channel: 'unknown-route',
        ts,
        raw: {
          context: {
            request: {
              url: { pathname: path },
              headers: { 'user-agent': agent, 'x-forwarded-for': `${ip}, 10.0.0.1` },
            },
          },
        },
      });
    const dayMs = 86_400_000;
    const stats = scannerStats([
      probe(dayMs, '/.env', 'zgrab', '1.2.3.4'),
      probe(dayMs + 1, '/.env', 'zgrab', '1.2.3.4'),
      probe(2 * dayMs, '/wp-login.php', 'curl/8', '5.6.7.8'),
      rec({ kind: 'transaction', channel: 'server', ts: dayMs }), // not scanner
    ]);
    expect(stats.total).toBe(3);
    expect(stats.perDay).toHaveLength(2);
    expect(stats.topPaths[0]).toEqual({ key: '/.env', count: 2 });
    expect(stats.topAgents[0].key).toBe('zgrab');
    expect(stats.topIps[0]).toEqual({ key: '1.2.3.4', count: 2 });
  });
});
