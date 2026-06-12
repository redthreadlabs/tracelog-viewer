import { describe, it, expect } from 'vitest';
import { appendPlan, takeTail, type FileState } from './live';
import { parseFile } from './parse';
import { parseKey } from '../s3/keys';

const enc = new TextEncoder();
const FILE = parseKey('server/2026-06-12/h_current.jsonl.gz')!;

const META = JSON.stringify({
  metadata: { service: { name: 's', version: '1.0.0' }, channel: 'server' },
});
const EV = (type: string) => JSON.stringify({ event: { type, timestamp: 1_000_000 } });

function state(bytes: Uint8Array, lastMeta = {}): FileState {
  return { etag: 'e1', byteLen: bytes.length, tail: takeTail(bytes), lastMeta };
}

describe('appendPlan', () => {
  const v1 = enc.encode(`${META}\n${EV('a')}\n`);
  const v2 = enc.encode(`${META}\n${EV('a')}\n${EV('b')}\n${EV('c')}\n`);

  it('returns the tail when the previous content is a verified prefix', () => {
    const tail = appendPlan(state(v1), v2);
    expect(tail).not.toBeNull();
    const text = new TextDecoder().decode(tail!);
    expect(text).toBe(`${EV('b')}\n${EV('c')}\n`);
  });

  it('rejects a shrunken file (writer restarted)', () => {
    expect(appendPlan(state(v2), v1)).toBeNull();
  });

  it('rejects when the boundary bytes differ (not a prefix)', () => {
    const other = enc.encode(`${META}\n${EV('different')}\n${EV('b')}\n`);
    expect(appendPlan(state(v1), other)).toBeNull();
  });

  it('rejects when the previous content did not end on a newline', () => {
    const noNewline = enc.encode(`${META}\n${EV('a')}`);
    const grown = enc.encode(`${META}\n${EV('a')}${EV('b')}\n`);
    expect(appendPlan(state(noNewline), grown)).toBeNull();
  });

  it('rejects empty previous state', () => {
    expect(appendPlan(state(enc.encode('')), v1)).toBeNull();
  });
});

describe('incremental tail parse', () => {
  it('carries the metadata context into tail records', () => {
    const v1 = enc.encode(`${META}\n${EV('a')}\n`);
    const first = parseFile(v1, FILE);
    expect(first.lastMeta.serviceVersion).toBe('1.0.0');

    const v2 = enc.encode(`${META}\n${EV('a')}\n${EV('b')}\n`);
    const tail = appendPlan(state(v1, first.lastMeta), v2)!;
    const second = parseFile(tail, FILE, first.lastMeta);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].name).toBe('b');
    expect(second.records[0].meta.serviceVersion).toBe('1.0.0');
    expect(second.lastMeta.serviceVersion).toBe('1.0.0');
  });

  it('a mid-tail metadata line (restart) updates the carried context', () => {
    const meta2 = JSON.stringify({
      metadata: { service: { name: 's', version: '2.0.0' }, channel: 'server' },
    });
    const v1 = enc.encode(`${META}\n${EV('a')}\n`);
    const first = parseFile(v1, FILE);
    const v2 = enc.encode(`${META}\n${EV('a')}\n${meta2}\n${EV('b')}\n`);
    const tail = appendPlan(state(v1, first.lastMeta), v2)!;
    const second = parseFile(tail, FILE, first.lastMeta);
    expect(second.records[0].meta.serviceVersion).toBe('2.0.0');
    expect(second.lastMeta.serviceVersion).toBe('2.0.0');
  });
});
