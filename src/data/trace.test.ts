import { describe, it, expect } from 'vitest';
import { assembleTrace, spanTypeToken } from './trace';
import type { Rec } from './types';

const TRACE = 't'.repeat(32);

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'span',
    ts: 0,
    channel: 'server',
    host: 'h',
    sourceKey: 'k',
    meta: {},
    name: 'x',
    traceId: TRACE,
    rawLine: '',
    line: 0,
    ...partial,
  };
}

describe('assembleTrace', () => {
  const txn = rec({
    kind: 'transaction',
    name: 'POST /speech/generate',
    ts: 1000,
    duration: 100,
    selfId: 'root0000root0000',
  });
  const spanA = rec({
    name: 'S3 ListObjectsV2',
    ts: 1010,
    duration: 20,
    selfId: 'aaaa0000aaaa0000',
    parentId: 'root0000root0000',
    result: 'storage/s3',
  });
  const spanB = rec({
    name: 'POST api.openai.com',
    ts: 1035,
    duration: 50,
    selfId: 'bbbb0000bbbb0000',
    parentId: 'root0000root0000',
    result: 'external/http',
  });
  const spanChild = rec({
    name: 'dns lookup',
    ts: 1036,
    duration: 4,
    selfId: 'cccc0000cccc0000',
    parentId: 'bbbb0000bbbb0000',
    result: 'external',
  });
  const event = rec({
    kind: 'event',
    name: 'speech-cache-miss',
    ts: 1012,
  });

  it('orders transaction → spans (DFS by start), nests children, appends points', () => {
    const model = assembleTrace([spanB, event, txn, spanChild, spanA], TRACE);
    expect(model.root?.name).toBe('POST /speech/generate');
    expect(model.rows.map((r) => r.rec.name)).toEqual([
      'POST /speech/generate',
      'S3 ListObjectsV2',
      'POST api.openai.com',
      'dns lookup',
      'speech-cache-miss',
    ]);
    expect(model.rows.map((r) => r.depth)).toEqual([0, 1, 1, 2, 1]);
  });

  it('nests a downstream service transaction under the caller span (distributed trace)', () => {
    const entry = rec({ kind: 'transaction', name: 'GET /v1/feed', ts: 1000, duration: 200, selfId: 'entry00000000000' });
    const dbSpan = rec({ name: 'SELECT users', ts: 1010, duration: 15, selfId: 'db00000000000000', parentId: 'entry00000000000', result: 'db/postgresql' });
    const callSpan = rec({ name: 'POST auth-service', ts: 1030, duration: 60, selfId: 'call000000000000', parentId: 'entry00000000000', result: 'external/http' });
    // the downstream service's transaction parents to the caller's exit span
    const downTxn = rec({ kind: 'transaction', name: 'POST /token', ts: 1032, duration: 50, selfId: 'down000000000000', parentId: 'call000000000000', transactionId: 'down000000000000' });
    const downSpan = rec({ name: 'SELECT credentials', ts: 1035, duration: 8, selfId: 'ds00000000000000', parentId: 'down000000000000', result: 'db/postgresql' });

    const model = assembleTrace([downSpan, callSpan, entry, downTxn, dbSpan], TRACE);
    expect(model.root?.name).toBe('GET /v1/feed');
    expect(model.rows.map((r) => r.rec.name)).toEqual([
      'GET /v1/feed',
      'SELECT users',
      'POST auth-service',
      'POST /token',
      'SELECT credentials',
    ]);
    // entry(0) → its spans(1) → the caller span's child is the downstream txn(2) → its span(3)
    expect(model.rows.map((r) => r.depth)).toEqual([0, 1, 1, 2, 3]);
  });

  it('computes trace bounds from bars and points', () => {
    const model = assembleTrace([txn, spanA, spanB, spanChild, event], TRACE);
    expect(model.t0).toBe(1000);
    expect(model.t1).toBe(1100); // txn end
  });

  it('shows spans with missing parents at depth 1', () => {
    const orphan = rec({
      name: 'orphan',
      ts: 1050,
      duration: 5,
      selfId: 'dddd0000dddd0000',
      parentId: 'missing0missing0',
    });
    const model = assembleTrace([txn, orphan], TRACE);
    expect(model.rows.map((r) => r.rec.name)).toEqual(['POST /speech/generate', 'orphan']);
    expect(model.rows[1].depth).toBe(1);
  });

  it('handles a trace with no transaction record', () => {
    const model = assembleTrace([spanA, spanB], TRACE);
    expect(model.root).toBeNull();
    expect(model.rows).toHaveLength(2);
    expect(model.t0).toBe(1010);
  });

  it('ignores records from other traces', () => {
    const other = rec({ traceId: 'x'.repeat(32), name: 'other' });
    const model = assembleTrace([txn, other], TRACE);
    expect(model.rows).toHaveLength(1);
  });
});

describe('spanTypeToken', () => {
  it('maps known type/subtype results to stable tokens', () => {
    expect(spanTypeToken(rec({ result: 'db/mongodb' }))).toBe('--spantype-db-mongodb');
    expect(spanTypeToken(rec({ result: 'db/redis' }))).toBe('--spantype-db-redis');
    expect(spanTypeToken(rec({ result: 'storage/s3' }))).toBe('--spantype-storage');
    expect(spanTypeToken(rec({ result: 'external/http' }))).toBe('--spantype-external');
    expect(spanTypeToken(rec({ result: 'weird' }))).toBe('--spantype-other');
    expect(spanTypeToken(rec({ kind: 'transaction' }))).toBe('--kind-transaction');
    expect(spanTypeToken(rec({ kind: 'event' }))).toBe('--kind-event');
  });
});
