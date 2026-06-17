import { describe, it, expect } from 'vitest';
import { filePayload } from './backend';
import { txnIndex } from '../data/indexes';
import { mergeRangeTotals, type TxnTotals, type TxnFileIndex } from '../data/txnindex';
import { SEP } from '../data/cache';
import type { Rec } from '../data/types';
import type { ParsedKey } from '../s3/keys';

const H0 = Date.UTC(2026, 5, 17, 0); // an aligned UTC hour

function txn(name: string, ts: number, duration: number, sourceKey: string): Rec {
  return {
    id: 0,
    kind: 'transaction',
    ts,
    duration,
    channel: 'server',
    host: 'h',
    sourceKey,
    meta: {},
    name,
    result: 'HTTP 2xx',
    rawLine: '',
    line: 0,
  } as Rec;
}

function file(key: string, etag: string, current = false): ParsedKey {
  return { key, etag, host: 'h', channel: 'server', interval: '2026-06-17', current } as ParsedKey;
}

/** minimal Session shape: filePayload only reads bucket.bucket, store.files, store.recordsOf */
function session(loaded: Map<string, Rec[]>) {
  return {
    bucket: { bucket: 'b' },
    store: {
      files: new Map([...loaded.keys()].map((k) => [k, {}])),
      recordsOf: (k: string) => loaded.get(k) ?? [],
    },
  } as unknown as Parameters<typeof filePayload>[0];
}

function countOf(payload: TxnFileIndex, name: string): number {
  const totals = new Map<string, TxnTotals>();
  mergeRangeTotals(payload, H0, H0 + 3_600_000, totals);
  return totals.get(name)?.c ?? 0;
}

describe('filePayload — the _current interval is never dropped', () => {
  it('builds the index in memory for a loaded-but-unindexed file (the _current interval)', () => {
    const key = 'server/2026-06-17/h_current.jsonl.gz';
    const recs = [txn('POST /x', H0 + 1000, 50, key), txn('POST /x', H0 + 2000, 70, key)];
    const stored = new Map(); // nothing persisted — _current is never indexed at parse time
    const payload = filePayload(session(new Map([[key, recs]])), txnIndex, stored, file(key, 'e1', true));
    expect(payload).not.toBeNull();
    expect(countOf(payload!, 'POST /x')).toBe(2);
  });

  it('prefers the persisted payload when its ETag matches', () => {
    const key = 'server/2026-06-16/h.jsonl.gz';
    const persisted = txnIndex.build([txn('POST /x', H0, 10, key)]); // count 1 in the index
    const stored = new Map([[`b${SEP}${key}`, { etag: 'e1', payload: persisted }]]);
    // store also has 2 records loaded — must be ignored in favor of the matching index
    const live = new Map([[key, [txn('POST /x', H0, 1, key), txn('POST /x', H0, 1, key)]]]);
    const payload = filePayload(session(live), txnIndex, stored, file(key, 'e1'));
    expect(countOf(payload!, 'POST /x')).toBe(1); // from the index, not the 2 loaded records
  });

  it('returns null only when a file is neither indexed nor loaded', () => {
    const f = file('server/2026-06-16/gone.jsonl.gz', 'e9');
    expect(filePayload(session(new Map()), txnIndex, new Map(), f)).toBeNull();
  });
});
