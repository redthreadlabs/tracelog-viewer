import { describe, it, expect } from 'vitest';
import { assembleTrace, spanTypeToken } from './trace';
import type { Rec } from './types';

const TRACE = 't'.repeat(32);

function rec(partial: Partial<Rec> & { raw?: Record<string, unknown> }): Rec {
  return {
    id: 0,
    kind: 'span',
    ts: 0,
    channel: 'server',
    host: 'h',
    meta: {},
    name: 'x',
    traceId: TRACE,
    raw: {},
    ...partial,
  };
}

describe('assembleTrace', () => {
  const txn = rec({
    kind: 'transaction',
    name: 'POST /speech/generate',
    ts: 1000,
    duration: 100,
    raw: { id: 'root0000root0000' },
  });
  const spanA = rec({
    name: 'S3 ListObjectsV2',
    ts: 1010,
    duration: 20,
    raw: { id: 'aaaa0000aaaa0000', parent_id: 'root0000root0000', type: 'storage', subtype: 's3' },
  });
  const spanB = rec({
    name: 'POST api.openai.com',
    ts: 1035,
    duration: 50,
    raw: { id: 'bbbb0000bbbb0000', parent_id: 'root0000root0000', type: 'external', subtype: 'http' },
  });
  const spanChild = rec({
    name: 'dns lookup',
    ts: 1036,
    duration: 4,
    raw: { id: 'cccc0000cccc0000', parent_id: 'bbbb0000bbbb0000', type: 'external' },
  });
  const event = rec({
    kind: 'event',
    name: 'speech-cache-miss',
    ts: 1012,
    raw: {},
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
      raw: { id: 'dddd0000dddd0000', parent_id: 'missing0missing0' },
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
  it('maps known type/subtype pairs to stable tokens', () => {
    expect(spanTypeToken(rec({ raw: { type: 'db', subtype: 'mongodb' } }))).toBe(
      '--spantype-db-mongodb',
    );
    expect(spanTypeToken(rec({ raw: { type: 'db', subtype: 'redis' } }))).toBe(
      '--spantype-db-redis',
    );
    expect(spanTypeToken(rec({ raw: { type: 'storage', subtype: 's3' } }))).toBe(
      '--spantype-storage',
    );
    expect(spanTypeToken(rec({ raw: { type: 'external', subtype: 'http' } }))).toBe(
      '--spantype-external',
    );
    expect(spanTypeToken(rec({ raw: { type: 'weird' } }))).toBe('--spantype-other');
    expect(spanTypeToken(rec({ kind: 'transaction', raw: {} }))).toBe('--kind-transaction');
    expect(spanTypeToken(rec({ kind: 'event', raw: {} }))).toBe('--kind-event');
  });
});
