/**
 * planScan working-set construction — specifically the host filter dimension
 * (channels × hosts × time range). A mock bucket returns canned listings so we
 * assert which files land in the plan and what the candidate host set is.
 */
import { describe, it, expect } from 'vitest';
import { planScan } from './scanner';
import { buildKey } from './keys';
import type { LogBucket } from './client';

const DAY = '2026-06-11';
const SPAN: [number, number] = [Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 23, 59)];

/** A bucket whose channels each list one finalized file per given host. */
function mockBucket(layout: Record<string, string[]>): LogBucket {
  return {
    bucket: 'test',
    listChannelRange: async (channel: string) =>
      (layout[channel] ?? []).map((host) => ({
        key: buildKey({ channel, interval: DAY, host }, true),
        size: 100,
        lastModified: new Date(SPAN[0]),
        etag: `${channel}-${host}`,
      })),
  } as unknown as LogBucket;
}

describe('planScan host filter', () => {
  const layout = { server: ['10.0.0.1', '10.0.0.2', '10.0.0.3'] };

  it('reports every candidate host in allHosts, regardless of the filter', async () => {
    const plan = await planScan(mockBucket(layout), ['server'], SPAN[0], SPAN[1], ['10.0.0.1']);
    expect(plan.allHosts).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('undefined host filter loads every host', async () => {
    const plan = await planScan(mockBucket(layout), ['server'], SPAN[0], SPAN[1]);
    expect(plan.files.map((f) => f.host).sort()).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(plan.hosts).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it('a host list narrows the plan to those hosts', async () => {
    const plan = await planScan(mockBucket(layout), ['server'], SPAN[0], SPAN[1], ['10.0.0.1', '10.0.0.3']);
    expect(plan.files.map((f) => f.host).sort()).toEqual(['10.0.0.1', '10.0.0.3']);
    expect(plan.hosts).toEqual(['10.0.0.1', '10.0.0.3']);
    expect(plan.allHosts).toHaveLength(3); // candidates still report all
  });

  it('an empty host list yields an empty plan (none selected)', async () => {
    const plan = await planScan(mockBucket(layout), ['server'], SPAN[0], SPAN[1], []);
    expect(plan.files).toHaveLength(0);
    expect(plan.allHosts).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']); // still discoverable
  });

  it('hosts span channels — the candidate set is the union', async () => {
    const plan = await planScan(
      mockBucket({ server: ['10.0.0.1'], worker: ['10.0.0.2'] }),
      ['server', 'worker'],
      SPAN[0],
      SPAN[1],
    );
    expect(plan.allHosts).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});
