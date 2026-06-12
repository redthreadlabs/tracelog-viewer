import { describe, it, expect } from 'vitest';
import { Store } from './store';
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
