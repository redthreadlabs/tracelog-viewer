import { describe, it, expect } from 'vitest';
import { parseKey, dedupeCurrents } from './keys';

describe('parseKey (SPEC §3.1 grammar)', () => {
  it('parses a finalized daily file', () => {
    const p = parseKey('server/2026-06-12/172.31.27.225.jsonl.gz', 1234);
    expect(p).toMatchObject({
      channel: 'server',
      interval: '2026-06-12',
      host: '172.31.27.225',
      seq: 0,
      current: false,
      size: 1234,
    });
  });

  it('parses a live snapshot', () => {
    const p = parseKey('client/2026-06-12/172.31.27.225_current.jsonl.gz');
    expect(p).toMatchObject({ host: '172.31.27.225', current: true, seq: 0 });
  });

  it('parses a size-overflow file with sequence', () => {
    const p = parseKey('server/2026-06-12/172.31.27.225_3.jsonl.gz');
    expect(p).toMatchObject({ host: '172.31.27.225', seq: 3, current: false });
  });

  it('parses an overflow live snapshot', () => {
    const p = parseKey('server/2026-06-12/172.31.27.225_3_current.jsonl.gz');
    expect(p).toMatchObject({ seq: 3, current: true });
  });

  it('parses hourly intervals', () => {
    const p = parseKey('server/2026-06-12T14/host.example.jsonl.gz');
    expect(p?.interval).toBe('2026-06-12T14');
  });

  it('accepts uncompressed .jsonl', () => {
    expect(parseKey('server/2026-06-12/host.jsonl')?.host).toBe('host');
  });

  it('rejects keys outside the grammar without throwing', () => {
    expect(parseKey('not-a-log.txt')).toBeNull();
    expect(parseKey('a/b/c/d.jsonl.gz')).toBeNull();
    expect(parseKey('server/2026-06-12/host_weird_thing.jsonl.gz')).toBeNull();
  });
});

describe('dedupeCurrents (SPEC §3.5)', () => {
  it('drops a current shadowed by its finalized file', () => {
    const files = [
      parseKey('server/2026-06-11/h.jsonl.gz')!,
      parseKey('server/2026-06-11/h_current.jsonl.gz')!,
    ];
    const out = dedupeCurrents(files);
    expect(out).toHaveLength(1);
    expect(out[0].current).toBe(false);
  });

  it('keeps a dead-host current with no finalized sibling', () => {
    const files = [
      parseKey('server/2026-06-10/h_current.jsonl.gz')!,
      parseKey('server/2026-06-11/h.jsonl.gz')!,
    ];
    expect(dedupeCurrents(files)).toHaveLength(2);
  });

  it('does not cross seq boundaries', () => {
    const files = [
      parseKey('server/2026-06-11/h.jsonl.gz')!,
      parseKey('server/2026-06-11/h_1_current.jsonl.gz')!,
    ];
    expect(dedupeCurrents(files)).toHaveLength(2);
  });
});
