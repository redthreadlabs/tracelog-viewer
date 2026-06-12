import { describe, it, expect } from 'vitest';
import { parseKey, dedupeCurrents, intervalSpan, overlapsRange } from './keys';

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

describe('intervalSpan / overlapsRange (hour-granular fetch filtering)', () => {
  it('spans daily and hourly intervals', () => {
    expect(intervalSpan('2026-06-12')).toEqual([
      Date.UTC(2026, 5, 12),
      Date.UTC(2026, 5, 13),
    ]);
    expect(intervalSpan('2026-06-12T14')).toEqual([
      Date.UTC(2026, 5, 12, 14),
      Date.UTC(2026, 5, 12, 15),
    ]);
    expect(intervalSpan('weird')).toBeNull();
  });

  it('fetches only the covering hours of an hourly bucket', () => {
    const h13 = parseKey('server/2026-06-12T13/h.jsonl.gz')!;
    const h14 = parseKey('server/2026-06-12T14/h.jsonl.gz')!;
    const h15 = parseKey('server/2026-06-12T15/h.jsonl.gz')!;
    const from = Date.UTC(2026, 5, 12, 14, 10);
    const to = Date.UTC(2026, 5, 12, 14, 40);
    expect(overlapsRange(h13, from, to)).toBe(false);
    expect(overlapsRange(h14, from, to)).toBe(true);
    expect(overlapsRange(h15, from, to)).toBe(false);
  });

  it('keeps a daily file for any sub-range of its day, and unknown layouts', () => {
    const daily = parseKey('server/2026-06-12/h.jsonl.gz')!;
    const from = Date.UTC(2026, 5, 12, 14, 10);
    const to = Date.UTC(2026, 5, 12, 14, 40);
    expect(overlapsRange(daily, from, to)).toBe(true);
    expect(overlapsRange({ ...daily, interval: 'v2-custom' }, from, to)).toBe(true);
  });

  it('handles ranges spanning an hour boundary', () => {
    const h14 = parseKey('server/2026-06-12T14/h.jsonl.gz')!;
    const h15 = parseKey('server/2026-06-12T15/h.jsonl.gz')!;
    const from = Date.UTC(2026, 5, 12, 14, 50);
    const to = Date.UTC(2026, 5, 12, 15, 10);
    expect(overlapsRange(h14, from, to)).toBe(true);
    expect(overlapsRange(h15, from, to)).toBe(true);
  });
});
