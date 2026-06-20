import { describe, it, expect } from 'vitest';
import { Store, mergeByTime, rangeBounds, rangeSlice } from './store';
import type { Rec } from './types';

function rec(partial: Partial<Rec>): Rec {
  return {
    id: Math.random(),
    kind: 'event',
    ts: 0,
    channel: 'server',
    host: 'h',
    sourceKey: 'k1',
    meta: {},
    name: 'x',
    rawLine: '',
    line: 0,
    ...partial,
  };
}

describe('Store.replaceFile', () => {
  it('replaces records by source key, keeps others, resorts, recounts', () => {
    const store = new Store();
    store.addBatch([
      rec({ sourceKey: 'a', ts: 1, level: 'info' }),
      rec({ sourceKey: 'a', ts: 2, level: 'warn' }),
      rec({ sourceKey: 'b', ts: 3, kind: 'transaction' }),
    ]);

    store.replaceFile('a', [
      rec({ sourceKey: 'a', ts: 5, level: 'error' }),
      rec({ sourceKey: 'a', ts: 1, level: 'info' }),
      rec({ sourceKey: 'a', ts: 2, level: 'warn' }),
    ]);

    expect(store.records).toHaveLength(4);
    expect(store.records.map((r) => r.ts)).toEqual([1, 2, 3, 5]);
    expect(store.kindCounts.get('event')).toBe(3);
    expect(store.kindCounts.get('transaction')).toBe(1);
    expect(store.levelCounts.get('error')).toBe(1);
  });

  it('purges a file with an empty batch (finalized supersedes _current)', () => {
    const store = new Store();
    store.addBatch([rec({ sourceKey: 'cur', ts: 1 }), rec({ sourceKey: 'fin', ts: 2 })]);
    store.replaceFile('cur', []);
    expect(store.records).toHaveLength(1);
    expect(store.records[0].sourceKey).toBe('fin');
  });

  it('bumps generation and emits data', () => {
    const store = new Store();
    let events = 0;
    store.addEventListener('data', () => events++);
    const before = store.generation;
    store.replaceFile('a', [rec({})]);
    expect(store.generation).toBeGreaterThan(before);
    expect(events).toBe(1);
  });
});

describe('file registry + eviction', () => {
  const FILE = {
    key: 'server/2026-06-12/h_current.jsonl.gz',
    channel: 'server',
    interval: '2026-06-12',
    host: 'h',
    seq: 0,
    current: true,
    size: 5000,
  };

  it('registers files and accumulates appended bytes', () => {
    const store = new Store();
    store.registerFile(FILE, 20_000);
    store.registerFile(FILE, 1_000, true);
    const info = store.files.get(FILE.key)!;
    expect(info.sizeCompressed).toBe(5000);
    expect(info.sizeUncompressed).toBe(21_000);
    expect(info.current).toBe(true);
  });

  it('dropFile removes records and the registry row', () => {
    const store = new Store();
    store.registerFile(FILE, 20_000);
    store.addBatch([rec({ sourceKey: FILE.key })]);
    store.dropFile(FILE.key);
    expect(store.records).toHaveLength(0);
    expect(store.files.has(FILE.key)).toBe(false);
  });

  it('clear wipes the registry', () => {
    const store = new Store();
    store.registerFile(FILE, 20_000);
    store.clear();
    expect(store.files.size).toBe(0);
  });
});

describe('data-event throttling during a scan', () => {
  it('streams freely when idle, throttles while running, and always emits the final sort', () => {
    const s = new Store();
    let events = 0;
    s.addEventListener('data', () => events++);

    // idle (live mode, single loads): every batch dispatches
    s.addBatch([]);
    s.addBatch([]);
    expect(events).toBe(2);

    // running: batches within the wait window are throttled
    s.setProgress({ running: true });
    s.addBatch([]);
    s.addBatch([]);
    s.addBatch([]);
    expect(events).toBe(2);

    // the scan's closing sort must never be throttled away
    s.sortByTime();
    expect(events).toBe(3);
  });
});

describe('file-rooted indexes', () => {
  const mk = (partial: Partial<Rec>): Rec => rec({ kind: 'transaction', ...partial });

  it('serves transactions by name across files, time-sorted', () => {
    const s = new Store();
    s.addBatch([
      mk({ name: 'GET /api/feed', ts: 30, sourceKey: 'f1' }),
      mk({ name: 'GET /api/feed', ts: 10, sourceKey: 'f1' }),
      mk({ name: 'GET /healthz', ts: 20, sourceKey: 'f1' }),
    ]);
    s.addBatch([mk({ name: 'GET /api/feed', ts: 20, sourceKey: 'f2' })]);
    expect(s.transactionsNamed('GET /api/feed').map((r) => r.ts)).toEqual([10, 20, 30]);
    expect(s.transactionsNamed('GET /healthz')).toHaveLength(1);
    expect(s.transactionsNamed('nope')).toEqual([]);
  });

  it('serves trace records across kinds and files', () => {
    const s = new Store();
    s.addBatch([
      mk({ ts: 10, traceId: 't1', sourceKey: 'f1' }),
      rec({ kind: 'span', ts: 12, traceId: 't1', sourceKey: 'f1' }),
      rec({ kind: 'error', ts: 14, traceId: 't1', sourceKey: 'f2' }),
      rec({ kind: 'span', ts: 11, traceId: 'other', sourceKey: 'f1' }),
    ]);
    expect(s.traceRecords('t1').map((r) => r.kind)).toEqual(['transaction', 'span', 'error']);
  });

  it('memoizes kindRecords per generation and invalidates on change', () => {
    const s = new Store();
    s.addBatch([rec({ kind: 'event', ts: 2 }), rec({ kind: 'event', ts: 1 })]);
    const first = s.kindRecords('event');
    expect(first.map((r) => r.ts)).toEqual([1, 2]);
    expect(s.kindRecords('event')).toBe(first); // same generation → same array
    s.addBatch([rec({ kind: 'event', ts: 3 })]);
    const second = s.kindRecords('event');
    expect(second).not.toBe(first);
    expect(second).toHaveLength(3);
  });

  it('dropFile removes a file from every index at once', () => {
    const s = new Store();
    s.addBatch([
      mk({ name: 'GET /x', ts: 1, traceId: 'tA', sourceKey: 'f1' }),
      mk({ name: 'GET /x', ts: 2, traceId: 'tB', sourceKey: 'f2' }),
    ]);
    s.dropFile('f1');
    expect(s.transactionsNamed('GET /x')).toHaveLength(1);
    expect(s.traceRecords('tA')).toEqual([]);
    expect(s.kindRecords('transaction')).toHaveLength(1);
  });

  it('replaceFile reindexes only that file', () => {
    const s = new Store();
    s.addBatch([mk({ name: 'GET /x', ts: 1, sourceKey: 'live' })]);
    s.replaceFile('live', [
      mk({ name: 'GET /x', ts: 1, sourceKey: 'live' }),
      mk({ name: 'GET /x', ts: 2, sourceKey: 'live' }),
    ]);
    expect(s.transactionsNamed('GET /x')).toHaveLength(2);
  });
});

describe('mergeByTime', () => {
  it('merges two sorted arrays stably', () => {
    const a = [rec({ ts: 1 }), rec({ ts: 3 })];
    const b = [rec({ ts: 2 }), rec({ ts: 4 })];
    expect(mergeByTime(a, b).map((r) => r.ts)).toEqual([1, 2, 3, 4]);
    expect(mergeByTime([], b)).toBe(b);
  });
});

describe('rangeBounds / rangeSlice (binary-searched time filters)', () => {
  const sorted = [10, 20, 30, 40, 50].map((ts) => rec({ ts }));

  it('finds inclusive bounds inside the array', () => {
    expect(rangeBounds(sorted, [20, 40])).toEqual([1, 4]);
    expect(rangeSlice(sorted, [20, 40]).map((r) => r.ts)).toEqual([20, 30, 40]);
  });

  it('handles windows between records and past the ends', () => {
    expect(rangeBounds(sorted, [21, 29])).toEqual([2, 2]); // empty run
    expect(rangeBounds(sorted, [0, 5])).toEqual([0, 0]);
    expect(rangeBounds(sorted, [60, 99])).toEqual([5, 5]);
    expect(rangeBounds(sorted, [15, 999])).toEqual([1, 5]);
  });

  it('returns the original array (no copy) when nothing is excluded', () => {
    expect(rangeSlice(sorted, null)).toBe(sorted);
    expect(rangeSlice(sorted, [0, 100])).toBe(sorted);
    expect(rangeSlice([], [1, 2])).toEqual([]);
  });
});

describe('Store origin join (lifetimeId → RecordOrigin)', () => {
  const origin = {
    lifetimeId: 'L1', appVersion: '1.4.0', device: 'iPhone 16 Pro',
    deviceId: 'install-9', os: 'iOS 26.5',
  };

  it('enriches records whose origin is registered before they land', () => {
    const store = new Store();
    store.registerOrigins([origin]);
    store.addBatch([rec({ lifetimeId: 'L1', ts: 1 }), rec({ lifetimeId: 'L2', ts: 2 })]);

    const [a, b] = store.records;
    expect(a.appVersion).toBe('1.4.0');
    expect(a.device).toBe('iPhone 16 Pro');
    expect(a.deviceId).toBe('install-9');
    expect(a.os).toBe('iOS 26.5');
    expect(b.appVersion).toBeUndefined(); // L2's origin not loaded
  });

  it('back-fills already-loaded records when their origin arrives later (out-of-order files)', () => {
    const store = new Store();
    store.addBatch([rec({ lifetimeId: 'L1', ts: 1 })]); // record first, no origin yet
    expect(store.records[0].device).toBeUndefined();

    store.registerOrigins([origin]); // origin file lands afterwards
    expect(store.records[0].device).toBe('iPhone 16 Pro');
    expect(store.records[0].appVersion).toBe('1.4.0');
  });

  it('originFor resolves a known lifetime and ignores unknown / undefined', () => {
    const store = new Store();
    store.registerOrigins([origin]);
    expect(store.originFor('L1')?.device).toBe('iPhone 16 Pro');
    expect(store.originFor('nope')).toBeUndefined();
    expect(store.originFor(undefined)).toBeUndefined();
  });

  it('clear() drops accumulated origins', () => {
    const store = new Store();
    store.registerOrigins([origin]);
    store.clear();
    expect(store.originFor('L1')).toBeUndefined();
  });
});
