import { describe, it, expect } from 'vitest';
import { parseFile, parseFileStreaming, parseRaw, nthLine } from './parse';
import { gzip, gunzipForEachLine, gunzipLineN } from './gzip';
import { parseKey } from '../s3/keys';

const FILE = parseKey('server/2026-06-12/172.31.27.225_current.jsonl.gz', 100)!;

function ndjson(lines: unknown[]): Uint8Array {
  return new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const META = {
  metadata: {
    service: {
      name: 'fleet-api',
      version: '1.19.1',
      environment: 'prod',
      node: { configured_name: 'fleet-prod-server' },
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
    expect(rec.meta.nodeName).toBe('fleet-prod-server');
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
          name: 'FIND app.users',
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

describe('eager extraction (lazy-raw memory model)', () => {
  it('extracts span ids, metricset samples, and client fields at parse time', () => {
    const bytes = ndjson([
      META,
      {
        span: {
          name: 's',
          type: 'db',
          subtype: 'mongodb',
          id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          transaction_id: 'c'.repeat(16),
          parent_id: 'c'.repeat(16),
          timestamp: 5000000,
          duration: 1,
        },
      },
      {
        metricset: {
          timestamp: 6000000,
          samples: { 'nodejs.eventloop.delay.avg.ms': { value: 1.5 }, bad: { value: 'x' } },
          span: { type: 'db', subtype: 'mongodb' },
          transaction: { name: 'GET /x' },
        },
      },
      {
        event: {
          type: 'app-startup',
          timestamp: 7000000,
          client: {
            version: '1.4.0',
            device: { model: 'iPhone 16 Pro' },
            os: { name: 'iOS', version: '26.5' },
          },
        },
      },
    ]);
    const { records } = parseFile(bytes, FILE);
    const [span, metricset, event] = records;
    expect(span.selfId).toBe('a'.repeat(16));
    expect(span.parentId).toBe('c'.repeat(16));
    expect(metricset.samples).toEqual({ 'nodejs.eventloop.delay.avg.ms': 1.5 });
    expect(metricset.result).toBe('db/mongodb');
    expect(event.appVersion).toBe('1.4.0');
    expect(event.device).toBe('iPhone 16 Pro');
    expect(event.os).toBe('iOS 26.5');
  });

  it('keeps the original line and parseRaw round-trips it', () => {
    const bytes = ndjson([META, { event: { type: 'x', timestamp: 1000000, params: { a: 1 } } }]);
    const { records } = parseFile(bytes, FILE);
    expect(records[0].rawLine).toContain('"params"');
    const raw = parseRaw(records[0]);
    expect((raw.params as Record<string, unknown>).a).toBe(1);
  });
});

describe('rawLine shedding (SPEC §8: finalized files re-read raw on demand)', () => {
  const lines = [
    JSON.stringify(META),
    JSON.stringify({ span: { name: 'SELECT FROM users', type: 'db', id: 'a'.repeat(16), trace_id: 'b'.repeat(32), transaction_id: 'c'.repeat(16), parent_id: 'c'.repeat(16), duration: 5, timestamp: 1_700_000_000_000_000, sync: false, outcome: 'success' } }),
    JSON.stringify({ event: { type: 'purchase', timestamp: 1_700_000_000_000_000, level: 'info', params: { total: 12.5 } } }),
  ];
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  const file = { key: 'ch/2026-06-11/h.jsonl.gz', channel: 'ch', interval: '2026-06-11', host: 'h', seq: 0, current: false, size: 1 } as never;

  it('sheds span raw but keeps event raw, with correct line indices', () => {
    const out = parseFile(bytes, file, {}, true);
    const span = out.records.find((r) => r.kind === 'span')!;
    const event = out.records.find((r) => r.kind === 'event')!;
    expect(span.rawLine).toBeNull();
    expect(span.line).toBe(1);
    expect(event.rawLine).toBe(lines[2]);
    expect(event.line).toBe(2);
    expect(parseRaw(span)).toEqual({}); // sync path declines; rawsource handles it
    expect(parseRaw(event).params).toEqual({ total: 12.5 });
  });

  it('retains every line when shedRaw is off (live tails)', () => {
    const out = parseFile(bytes, file);
    expect(out.records.every((r) => typeof r.rawLine === 'string')).toBe(true);
  });

  it('nthLine extracts by 0-based index, null past the end', () => {
    const text = 'a\nbb\nccc\n';
    expect(nthLine(text, 0)).toBe('a');
    expect(nthLine(text, 2)).toBe('ccc');
    expect(nthLine(text, 3)).toBeNull();
  });
});

describe('streaming inflate', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const stripId = (recs: { id: number }[]) => recs.map(({ id: _id, ...r }) => r);

  it('gunzipForEachLine yields every line + the exact decompressed byte length', async () => {
    const text = 'alpha\nbravo\ncharlie\n';
    const lines: [string, number][] = [];
    const total = await gunzipForEachLine(await gzip(enc(text)), (l, n) => lines.push([l, n]));
    expect(lines).toEqual([['alpha', 0], ['bravo', 1], ['charlie', 2]]);
    expect(total).toBe(text.length); // ascii: bytes == chars
  });

  it('gunzipForEachLine yields a final line with no trailing newline', async () => {
    const lines: string[] = [];
    await gunzipForEachLine(await gzip(enc('one\ntwo')), (l) => lines.push(l));
    expect(lines).toEqual(['one', 'two']);
  });

  it('gunzipLineN returns the nth line (0-based), null past the end', async () => {
    const gz = await gzip(enc('a\nbb\nccc\n'));
    expect(await gunzipLineN(gz, 0)).toBe('a');
    expect(await gunzipLineN(gz, 2)).toBe('ccc');
    expect(await gunzipLineN(gz, 3)).toBeNull();
  });

  it('parseFileStreaming matches parseFile on the same content', async () => {
    const bytes = ndjson([
      META,
      { transaction: { name: 'GET /a', type: 'request', id: 'a'.repeat(16), trace_id: 'b'.repeat(32), timestamp: 1781230284718007, duration: 10, result: 'HTTP 2xx', outcome: 'success' } },
      { event: { name: 'login', timestamp: 1781230284719000, level: 'info' } },
      'not json at all',
    ]);
    const full = parseFile(bytes, FILE);
    const streamed = await parseFileStreaming(await gzip(bytes), FILE);
    expect(stripId(streamed.records)).toEqual(stripId(full.records));
    expect(streamed.metas).toEqual(full.metas);
    expect(streamed.byteLength).toBe(full.byteLength);
    expect(streamed.skippedLines).toBe(full.skippedLines);
  });
});
