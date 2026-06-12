import { describe, it, expect } from 'vitest';
import { parseFile } from './parse';
import { registerRawSource, loadRawBody } from './rawsource';

const lines = [
  JSON.stringify({ metadata: { service: { name: 's', agent: { name: 'tracelog', version: '1' } } } }),
  JSON.stringify({ span: { name: 'GET cache', type: 'db', subtype: 'redis', id: 'a'.repeat(16), trace_id: 'b'.repeat(32), transaction_id: 'c'.repeat(16), parent_id: 'c'.repeat(16), duration: 1.5, timestamp: 1_700_000_000_000_000, sync: false, outcome: 'success', context: { db: { type: 'redis' } } } }),
];
const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
const file = { key: 'ch/2026-06-11/h.jsonl.gz', channel: 'ch', interval: '2026-06-11', host: 'h', seq: 0, current: false, size: 1 } as never;

describe('loadRawBody', () => {
  it('re-reads a shed line from the registered source (cache miss → fetch)', async () => {
    // node has no indexedDB, so cacheGetAny degrades to null → fetch path
    const fetched: string[] = [];
    registerRawSource({
      bucket: 'b',
      fetch: (key) => {
        fetched.push(key);
        return Promise.resolve(bytes);
      },
    });
    const span = parseFile(bytes, file, {}, true).records[0];
    expect(span.rawLine).toBeNull();
    const body = await loadRawBody(span);
    expect(body.name).toBe('GET cache');
    expect((body.context as { db: { type: string } }).db.type).toBe('redis');
    expect(fetched).toEqual(['ch/2026-06-11/h.jsonl.gz']);
    registerRawSource(null);
  });

  it('uses the retained line without touching the source', async () => {
    registerRawSource(null);
    const span = parseFile(bytes, file).records[0]; // retained
    const body = await loadRawBody(span);
    expect(body.name).toBe('GET cache');
  });
});
