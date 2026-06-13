import { describe, it, expect } from 'vitest';
import { estimateDecompressed, deriveRatios, type SizeRecord } from './ledger';

const rec = (p: Partial<SizeRecord>): SizeRecord => ({
  id: 'b k',
  channel: 'server',
  interval: '2026-06-11',
  compressed: 100,
  displayedAt: 0,
  cached: false,
  ...p,
});

describe('deriveRatios', () => {
  it('computes per-channel and overall decompressed/compressed ratios', () => {
    const r = deriveRatios([
      rec({ channel: 'server', compressed: 100, decompressed: 1000 }),
      rec({ channel: 'server', compressed: 100, decompressed: 1200 }),
      rec({ channel: 'client', compressed: 50, decompressed: 250 }),
      rec({ channel: 'server', compressed: 100 }), // no decompressed -> ignored
    ]);
    expect(r.byChannel.get('server')).toBeCloseTo(11); // (1000+1200)/(100+100)
    expect(r.byChannel.get('client')).toBeCloseTo(5);
    expect(r.overall).toBeCloseTo((1000 + 1200 + 250) / (100 + 100 + 50));
  });

  it('falls back to the default ratio with no measured data', () => {
    expect(deriveRatios([]).overall).toBe(10);
    expect(deriveRatios([rec({})]).overall).toBe(10); // no decompressed anywhere
  });
});

describe('estimateDecompressed', () => {
  const ratios = { byChannel: new Map([['server', 8], ['client', 4]]), overall: 6 };

  it('uses the known decompressed size when present', () => {
    expect(
      estimateDecompressed([{ channel: 'server', compressed: 100, decompressed: 777 }], ratios),
    ).toBe(777);
  });

  it('estimates from the channel ratio when decompressed is unknown', () => {
    expect(estimateDecompressed([{ channel: 'server', compressed: 100 }], ratios)).toBe(800);
    expect(estimateDecompressed([{ channel: 'client', compressed: 100 }], ratios)).toBe(400);
  });

  it('falls back to the overall ratio for an unseen channel', () => {
    expect(estimateDecompressed([{ channel: 'tier-x', compressed: 100 }], ratios)).toBe(600);
  });

  it('sums a mixed set', () => {
    expect(
      estimateDecompressed(
        [
          { channel: 'server', compressed: 100, decompressed: 500 },
          { channel: 'client', compressed: 100 },
        ],
        ratios,
      ),
    ).toBe(900); // 500 + 400
  });
});

import { evictionOrder } from './ledger';

describe('evictionOrder', () => {
  const r = (p: Partial<SizeRecord>): SizeRecord =>
    rec({ cached: true, decompressed: 100, ...p });

  it('drops least-recently-displayed first', () => {
    const order = evictionOrder([
      r({ id: 'new', displayedAt: 200 }),
      r({ id: 'old', displayedAt: 100 }),
    ]);
    expect(order.map((x) => x.id)).toEqual(['old', 'new']);
  });

  it('breaks recency ties by older interval first', () => {
    const order = evictionOrder([
      r({ id: 'jun', displayedAt: 100, interval: '2026-06-11' }),
      r({ id: 'may', displayedAt: 100, interval: '2026-05-01' }),
    ]);
    expect(order.map((x) => x.id)).toEqual(['may', 'jun']);
  });

  it('breaks interval ties by bigger file first', () => {
    const order = evictionOrder([
      r({ id: 'small', displayedAt: 100, interval: '2026-06-11', decompressed: 10 }),
      r({ id: 'big', displayedAt: 100, interval: '2026-06-11', decompressed: 999 }),
    ]);
    expect(order.map((x) => x.id)).toEqual(['big', 'small']);
  });
});

import { clampByMemory } from './ledger';

describe('clampByMemory', () => {
  const files = [
    { interval: '2026-06-09' },
    { interval: '2026-06-11' }, // newest
    { interval: '2026-06-10' },
  ];
  const perFile = [30, 40, 50]; // bytes, aligned to files

  it('keeps the newest files that fit, in original order', () => {
    // limit 100: newest (11)=40, then (10)=50 -> 90 fits, (09)=30 would be 120 -> stop
    expect(clampByMemory(files, perFile, 100)).toEqual([1, 2]);
  });

  it('keeps everything when the whole view fits', () => {
    expect(clampByMemory(files, perFile, 1000)).toEqual([0, 1, 2]);
  });

  it('always keeps at least the single most-recent file', () => {
    // limit smaller than any one file: still keep the newest (index 1)
    expect(clampByMemory(files, perFile, 1)).toEqual([1]);
  });
});
