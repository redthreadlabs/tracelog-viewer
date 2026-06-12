import { describe, it, expect } from 'vitest';
import { PerfLog, type PerfEntry } from './perf';

function entry(patch: Partial<PerfEntry> = {}): PerfEntry {
  return { ts: 1, cat: 'parse', name: 'op', ms: 5, ...patch };
}

describe('PerfLog', () => {
  it('begin() measures a duration and applies the patch', () => {
    const log = new PerfLog();
    const done = log.begin('fetch', 'a/b.jsonl.gz');
    done({ bytes: 123, cached: true });
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0];
    expect(e.cat).toBe('fetch');
    expect(e.name).toBe('a/b.jsonl.gz');
    expect(e.bytes).toBe(123);
    expect(e.cached).toBe(true);
    expect(e.ms).toBeGreaterThanOrEqual(0);
    expect(e.ts).toBeGreaterThan(1_700_000_000_000);
  });

  it('caps the ring buffer and drops the oldest entries', () => {
    const log = new PerfLog();
    for (let i = 0; i < 2600; i++) log.push(entry({ name: `op-${i}` }));
    expect(log.entries).toHaveLength(2500);
    expect(log.entries[0].name).toBe('op-100');
    expect(log.entries[2499].name).toBe('op-2599');
  });

  it('dispatches an event per push and bumps the generation', () => {
    const log = new PerfLog();
    let events = 0;
    log.addEventListener('entry', () => events++);
    const before = log.generation;
    log.push(entry());
    log.push(entry());
    expect(events).toBe(2);
    expect(log.generation).toBe(before + 2);
  });

  it('clear() empties the log and notifies', () => {
    const log = new PerfLog();
    log.push(entry());
    let notified = false;
    log.addEventListener('entry', () => (notified = true));
    log.clear();
    expect(log.entries).toHaveLength(0);
    expect(notified).toBe(true);
  });

  it('exportJson() round-trips the entries', () => {
    const log = new PerfLog();
    log.push(entry({ name: 'scan s3://b', records: 42 }));
    const parsed = JSON.parse(log.exportJson());
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].records).toBe(42);
    expect(typeof parsed.exportedAt).toBe('string');
  });
});
