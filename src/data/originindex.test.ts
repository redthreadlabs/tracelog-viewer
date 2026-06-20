import { describe, it, expect } from 'vitest';
import {
  buildLocatorIndex,
  originIndexStats,
  has,
  linesFor,
  resolveOrigin,
  type LocatorFileIndex,
  type OriginResolverDeps,
} from './originindex';
import type { ParsedKey } from '../s3/keys';
import type { RecordOrigin } from '@redthreadlabs/tracelog-schema';

function file(channel: string, interval: string, host: string): ParsedKey {
  return { key: `${channel}/${interval}/${host}.jsonl.gz`, channel, interval, host, seq: 0, current: false, size: 1 } as ParsedKey;
}

const ORIGIN = (id: string): RecordOrigin => ({
  lifetime_id: id,
  service: { name: 'duiduidui-app', version: '1.4.0' },
  runtime: { name: 'react-native', version: '0.85' },
});

describe('keyed locator index (the general primitive)', () => {
  it('builds key → line[], tolerating multiple matches', () => {
    const idx = buildLocatorIndex([
      { key: 'L1', line: 3 },
      { key: 'L2', line: 5 },
      { key: 'L1', line: 9 },
    ]);
    expect(idx).toEqual({ L1: [3, 9], L2: [5] });
  });

  it('has() is the degenerate containment read; linesFor() the locators', () => {
    const idx: LocatorFileIndex = { L1: [3, 9] };
    expect(has(idx, 'L1')).toBe(true);
    expect(has(idx, 'nope')).toBe(false);
    expect(linesFor(idx, 'L1')).toEqual([3, 9]);
    expect(linesFor(idx, 'nope')).toEqual([]);
  });
});

describe('resolveOrigin (the bespoke backward hop)', () => {
  // helper: deps backed by an in-memory {fileKey → index} and {fileKey → {line → origin}}
  function deps(
    indexes: Record<string, LocatorFileIndex>,
    bodies: Record<string, Record<number, RecordOrigin>>,
  ): OriginResolverDeps & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      loadIndex: async (f) => indexes[f.key] ?? null,
      readOriginLine: async (f, line) => {
        reads.push(`${f.key}:${line}`);
        return bodies[f.key]?.[line] ?? null;
      },
    };
  }

  it('resolves within the record’s own interval (0 hops)', async () => {
    const f = file('client', '2026-06-12', 'h1');
    const d = deps({ [f.key]: { L1: [7] } }, { [f.key]: { 7: ORIGIN('L1') } });
    const origin = await resolveOrigin('L1', '2026-06-12', [f], 6, d);
    expect(origin?.lifetime_id).toBe('L1');
    expect(d.reads).toEqual([`${f.key}:7`]);
  });

  it('hops back to an earlier interval and reads the located line', async () => {
    const recFile = file('client', '2026-06-12', 'h1');   // records here, no origin
    const origFile = file('client', '2026-06-10', 'h1');  // origin two intervals back
    const d = deps({ [origFile.key]: { L1: [4] } }, { [origFile.key]: { 4: ORIGIN('L1') } });
    const origin = await resolveOrigin('L1', '2026-06-12', [recFile, origFile], 6, d);
    expect(origin?.lifetime_id).toBe('L1');
  });

  it('probes all hosts within an interval (load-balanced fleet)', async () => {
    const a = file('client', '2026-06-12', 'hA'); // origin landed on host B's file
    const b = file('client', '2026-06-12', 'hB');
    const d = deps({ [b.key]: { L1: [2] } }, { [b.key]: { 2: ORIGIN('L1') } });
    const origin = await resolveOrigin('L1', '2026-06-12', [a, b], 6, d);
    expect(origin?.lifetime_id).toBe('L1');
  });

  it('returns null when the origin is beyond maxHops existing intervals (a normal miss)', async () => {
    // maxHops counts distinct existing prior intervals walked (empty intervals
    // have no file to probe, so they aren't hops). Four intervals, origin in the
    // 4th, maxHops=2 ⇒ walk the record's + 2 prior = 3 intervals, stop short.
    const files = ['2026-06-12', '2026-06-11', '2026-06-10', '2026-06-09'].map((iv) => file('client', iv, 'h1'));
    const origFile = files[3]; // 2026-06-09
    const d = deps({ [origFile.key]: { L1: [4] } }, { [origFile.key]: { 4: ORIGIN('L1') } });
    const origin = await resolveOrigin('L1', '2026-06-12', files, 2, d);
    expect(origin).toBeNull();
    expect(d.reads).toEqual([]); // never even read the far line (hop cap)
  });

  it('never walks forward past the record’s interval', async () => {
    const recFile = file('client', '2026-06-10', 'h1');
    const future = file('client', '2026-06-12', 'h1'); // a later interval — must be ignored
    const d = deps({ [future.key]: { L1: [4] } }, { [future.key]: { 4: ORIGIN('L1') } });
    const origin = await resolveOrigin('L1', '2026-06-10', [recFile, future], 6, d);
    expect(origin).toBeNull();
  });
});

describe('originIndexStats (internals inventory)', () => {
  it('aggregates files, distinct lifetimes, locators, bytes', () => {
    const recs = new Map<string, { etag?: string; index: LocatorFileIndex }>([
      ['b\0client/2026-06-10/h', { etag: 'a', index: { L1: [3], L2: [5, 9] } }],
      ['b\0client/2026-06-11/h', { etag: 'b', index: { L3: [1] } }],
    ]);
    const s = originIndexStats(recs);
    expect(s.files).toBe(2);
    expect(s.lifetimes).toBe(3);   // L1, L2, L3
    expect(s.locators).toBe(4);    // 1 + 2 + 1
    expect(s.bytes).toBeGreaterThan(0);
  });

  it('is empty for a bucket with no origin indexes', () => {
    expect(originIndexStats(new Map())).toEqual({ files: 0, lifetimes: 0, locators: 0, bytes: 0 });
  });
});
