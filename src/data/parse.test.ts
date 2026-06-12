import { describe, it, expect } from 'vitest';
import { parseFile } from './parse';
import { parseKey } from '../s3/keys';

const FILE = parseKey('server/2026-06-12/172.31.27.225_current.jsonl.gz', 100)!;

function ndjson(lines: unknown[]): Uint8Array {
  return new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const META = {
  metadata: {
    service: {
      name: 'duiduidui-server',
      version: '1.19.1',
      environment: 'prod',
      node: { configured_name: 'ddd-prod-server' },
      agent: { name: 'tracelog', version: '1.7.0' },
    },
    process: { pid: 1234 },
    system: { hostname: '172.31.27.225' },
    channel: 'server',
  },
};

describe('parseFile', () => {
  it('attaches metadata context positionally and normalizes µs→ms', () => {
    const bytes = ndjson([
      META,
      {
        transaction: {
          name: 'GET /thing',
          type: 'request',
          id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          timestamp: 1781230284718007, // µs
          duration: 161.99,
          result: 'HTTP 2xx',
          outcome: 'success',
        },
      },
    ]);
    const { records, metas } = parseFile(bytes, FILE);
    expect(metas).toHaveLength(1);
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.kind).toBe('transaction');
    expect(rec.ts).toBeCloseTo(1781230284718.007, 3); // ms
    expect(rec.duration).toBe(161.99); // durations are already ms
    expect(rec.meta.serviceVersion).toBe('1.19.1');
    expect(rec.meta.nodeName).toBe('ddd-prod-server');
    expect(rec.outcome).toBe('success');
  });

  it('normalizes event records (µs timestamps, level, trace correlation)', () => {
    const bytes = ndjson([
      META,
      {
        event: {
          type: 'auth-verify-code',
          timestamp: 1781230080005000,
          level: 'info',
          message: 'code verified',
          trace_id: 'c'.repeat(32),
          transaction_id: 'd'.repeat(16),
          user: { id: 'u-1' },
          error: { message: 'nope', code: '4017' },
        },
      },
    ]);
    const { records } = parseFile(bytes, FILE);
    const rec = records[0];
    expect(rec.kind).toBe('event');
    expect(rec.ts).toBe(1781230080005);
    expect(rec.name).toBe('auth-verify-code');
    expect(rec.level).toBe('info');
    expect(rec.traceId).toBe('c'.repeat(32));
    expect(rec.userId).toBe('u-1');
    expect(rec.message).toBe('code verified');
  });

  it('handles a mid-file metadata line (process restart)', () => {
    const meta2 = structuredClone(META);
    meta2.metadata.service.version = '1.20.0';
    const bytes = ndjson([
      META,
      { event: { type: 'before', timestamp: 1000000, level: 'info' } },
      meta2,
      { event: { type: 'after', timestamp: 2000000, level: 'info' } },
    ]);
    const { records, metas } = parseFile(bytes, FILE);
    expect(metas).toHaveLength(2);
    expect(records[0].meta.serviceVersion).toBe('1.19.1');
    expect(records[1].meta.serviceVersion).toBe('1.20.0');
  });

  it('ignores unknown kinds and garbage lines without failing', () => {
    const text = [
      JSON.stringify(META),
      JSON.stringify({ futurekind: { whatever: 1 } }),
      'this is not json',
      JSON.stringify({ event: { type: 'ok', timestamp: 1000000 } }),
    ].join('\n');
    const { records, skippedLines, unknownKinds } = parseFile(
      new TextEncoder().encode(text),
      FILE,
    );
    expect(records).toHaveLength(1);
    expect(unknownKinds).toBe(1);
    expect(skippedLines).toBe(1);
  });

  it('defaults event level to info and extracts error message fallback', () => {
    const bytes = ndjson([
      META,
      { event: { type: 'op-failed', timestamp: 1000000, error: { message: 'doc not found' } } },
    ]);
    const { records } = parseFile(bytes, FILE);
    expect(records[0].level).toBe('info');
    expect(records[0].message).toBe('doc not found');
  });

  it('derives span detail from type/subtype', () => {
    const bytes = ndjson([
      META,
      {
        span: {
          name: 'FIND duiduidui.users',
          type: 'db',
          subtype: 'mongodb',
          id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          transaction_id: 'c'.repeat(16),
          parent_id: 'c'.repeat(16),
          timestamp: 5000000,
          duration: 12.5,
        },
      },
    ]);
    const { records } = parseFile(bytes, FILE);
    expect(records[0].result).toBe('db/mongodb');
    expect(records[0].transactionId).toBe('c'.repeat(16));
  });
});
