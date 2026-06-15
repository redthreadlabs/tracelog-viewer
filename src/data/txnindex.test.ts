import { describe, it, expect } from 'vitest';
import { buildTxnIndex } from './txnindex';
import type { Rec } from './types';

function rec(partial: Partial<Rec>): Rec {
  return {
    id: 0,
    kind: 'event',
    ts: 0,
    channel: 'server',
    host: 'h',
    sourceKey: 'k',
    meta: {},
    name: 'x',
    rawLine: '',
    line: 0,
    ...partial,
  };
}

describe('buildTxnIndex', () => {
  const H0 = Date.UTC(2026, 5, 11, 0, 30); // 2026-06-11T00 (UTC hour bucket)
  const H1 = Date.UTC(2026, 5, 11, 1, 15); // 2026-06-11T01

  it('rolls up count + Σ duration by transaction name within each UTC hour', () => {
    const idx = buildTxnIndex([
      rec({ kind: 'transaction', name: 'GET /a', ts: H0, duration: 100 }),
      rec({ kind: 'transaction', name: 'GET /a', ts: H0 + 1000, duration: 50 }),
      rec({ kind: 'transaction', name: 'GET /b', ts: H0, duration: 10 }),
      rec({ kind: 'transaction', name: 'GET /a', ts: H1, duration: 5 }),
      rec({ kind: 'span', name: 'GET /a', ts: H0, duration: 999 }), // not a transaction
      rec({ kind: 'transaction', name: 'GET /a', ts: 0 }), // malformed ts → skipped
    ]);
    expect(idx['2026-06-11T00']['GET /a']).toEqual({ c: 2, d: 150 });
    expect(idx['2026-06-11T00']['GET /b']).toEqual({ c: 1, d: 10 });
    expect(idx['2026-06-11T01']['GET /a']).toEqual({ c: 1, d: 5 });
    expect(Object.keys(idx)).toEqual(['2026-06-11T00', '2026-06-11T01']);
  });

  it('treats a missing duration as 0', () => {
    const idx = buildTxnIndex([rec({ kind: 'transaction', name: 'x', ts: Date.UTC(2026, 0, 1, 0) })]);
    expect(idx['2026-01-01T00']['x']).toEqual({ c: 1, d: 0 });
  });

  it('is empty when there are no transactions', () => {
    expect(buildTxnIndex([rec({ kind: 'span', ts: H0, duration: 5 })])).toEqual({});
  });
});
