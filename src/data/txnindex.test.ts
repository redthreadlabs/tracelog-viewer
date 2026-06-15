import { describe, it, expect } from 'vitest';
import { buildTxnIndex, txnIndexPoints, mergeRangeTotals, type TxnTotals } from './txnindex';
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

  it('rolls up count + Σ duration + error count by transaction name within each UTC hour', () => {
    const idx = buildTxnIndex([
      rec({ kind: 'transaction', name: 'GET /a', ts: H0, duration: 100, result: 'HTTP 2xx' }),
      rec({ kind: 'transaction', name: 'GET /a', ts: H0 + 1000, duration: 50, result: 'HTTP 5xx' }),
      rec({ kind: 'transaction', name: 'GET /b', ts: H0, duration: 10 }),
      rec({ kind: 'transaction', name: 'GET /a', ts: H1, duration: 5 }),
      rec({ kind: 'span', name: 'GET /a', ts: H0, duration: 999 }), // not a transaction
      rec({ kind: 'transaction', name: 'GET /a', ts: 0 }), // malformed ts → skipped
    ]);
    expect(idx['2026-06-11T00']['GET /a']).toEqual({ c: 2, d: 150, e: 1 }); // one 5xx
    expect(idx['2026-06-11T00']['GET /b']).toEqual({ c: 1, d: 10, e: 0 });
    expect(idx['2026-06-11T01']['GET /a']).toEqual({ c: 1, d: 5, e: 0 });
    expect(Object.keys(idx)).toEqual(['2026-06-11T00', '2026-06-11T01']);
  });

  it('treats a missing duration as 0', () => {
    const idx = buildTxnIndex([rec({ kind: 'transaction', name: 'x', ts: Date.UTC(2026, 0, 1, 0) })]);
    expect(idx['2026-01-01T00']['x']).toEqual({ c: 1, d: 0, e: 0 });
  });

  it('is empty when there are no transactions', () => {
    expect(buildTxnIndex([rec({ kind: 'span', ts: H0, duration: 5 })])).toEqual({});
  });
});

describe('txnIndexPoints', () => {
  const idx = buildTxnIndex([
    rec({ kind: 'transaction', name: 'GET /a', ts: Date.UTC(2026, 5, 11, 0, 30), duration: 100, result: 'HTTP 5xx' }),
    rec({ kind: 'transaction', name: 'GET /b', ts: Date.UTC(2026, 5, 11, 0, 45), duration: 50 }),
    rec({ kind: 'transaction', name: 'GET /a', ts: Date.UTC(2026, 5, 11, 1, 15), duration: 5 }),
  ]);
  const from = Date.UTC(2026, 5, 11, 0);
  const to = Date.UTC(2026, 5, 11, 2);

  it('emits one point per transaction name (native grouping)', () => {
    const pts = txnIndexPoints(idx, 'sum', 'duration', from, to);
    expect(pts).toEqual([
      { name: 'GET /a', t: Date.UTC(2026, 5, 11, 0), weight: 100 },
      { name: 'GET /b', t: Date.UTC(2026, 5, 11, 0), weight: 50 },
      { name: 'GET /a', t: Date.UTC(2026, 5, 11, 1), weight: 5 },
    ]);
  });

  it('weights by the requested field (sum errors → the bad-result counter)', () => {
    const pts = txnIndexPoints(idx, 'sum', 'errors', from, to);
    expect(pts).toEqual([{ name: 'GET /a', t: Date.UTC(2026, 5, 11, 0), weight: 1 }]); // one 5xx
  });

  it('projects onto a fixed key by summing all names per hour (file-level groupBy)', () => {
    const pts = txnIndexPoints(idx, 'sum', 'duration', from, to, undefined, 'web-01');
    expect(pts).toEqual([
      { name: 'web-01', t: Date.UTC(2026, 5, 11, 0), weight: 150 }, // 100 + 50
      { name: 'web-01', t: Date.UTC(2026, 5, 11, 1), weight: 5 },
    ]);
  });

  it('a fixed-key projection is filtered by show on that key', () => {
    expect(txnIndexPoints(idx, 'count', undefined, from, to, new Set(['web-02']), 'web-01')).toEqual([]);
    expect(txnIndexPoints(idx, 'count', undefined, from, to, new Set(['web-01']), 'web-01')).toEqual([
      { name: 'web-01', t: Date.UTC(2026, 5, 11, 0), weight: 2 },
      { name: 'web-01', t: Date.UTC(2026, 5, 11, 1), weight: 1 },
    ]);
  });
});

describe('mergeRangeTotals', () => {
  const idx = buildTxnIndex([
    rec({ kind: 'transaction', name: 'GET /a', ts: Date.UTC(2026, 5, 11, 0, 30), duration: 100, result: 'HTTP 5xx' }),
    rec({ kind: 'transaction', name: 'GET /b', ts: Date.UTC(2026, 5, 11, 0, 45), duration: 50 }),
    rec({ kind: 'transaction', name: 'GET /a', ts: Date.UTC(2026, 5, 11, 1, 15), duration: 5 }),
    rec({ kind: 'transaction', name: 'GET /a', ts: Date.UTC(2026, 5, 11, 2, 15), duration: 999 }), // outside [0,2)
  ]);

  it('sums count / Σduration / errors per name over whole-in-range hours', () => {
    const into = new Map<string, TxnTotals>();
    mergeRangeTotals(idx, Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 2), into);
    expect(into.get('GET /a')).toEqual({ c: 2, d: 105, e: 1 }); // 100 + 5, one 5xx; excludes the 02:00 row
    expect(into.get('GET /b')).toEqual({ c: 1, d: 50, e: 0 });
  });

  it('accumulates across files (distributive merge)', () => {
    const into = new Map<string, TxnTotals>();
    mergeRangeTotals(idx, Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 2), into);
    mergeRangeTotals(idx, Date.UTC(2026, 5, 11, 0), Date.UTC(2026, 5, 11, 2), into); // same file twice → doubles
    expect(into.get('GET /a')).toEqual({ c: 4, d: 210, e: 2 });
  });
});
