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
