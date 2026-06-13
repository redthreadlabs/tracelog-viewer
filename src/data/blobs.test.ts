import { describe, it, expect } from 'vitest';
import { MemBytes } from './blobs';

const buf = (n: number): Uint8Array => new Uint8Array(n);

describe('MemBytes', () => {
  it('stores and returns bytes, tracking the total', () => {
    const m = new MemBytes(null);
    m.put('a', buf(10));
    m.put('b', buf(20));
    expect(m.get('a')?.length).toBe(10);
    expect(m.bytes).toBe(30);
    expect(m.get('missing')).toBeUndefined();
  });

  it('evicts least-recently-used entries when over budget', () => {
    const m = new MemBytes(100);
    m.put('a', buf(40));
    m.put('b', buf(40));
    m.get('a'); // touch a → b is now the oldest
    m.put('c', buf(40)); // total 120 > 100 → evict oldest (b)
    expect(m.get('a')?.length).toBe(40);
    expect(m.get('b')).toBeUndefined();
    expect(m.get('c')?.length).toBe(40);
    expect(m.bytes).toBe(80);
  });

  it('always keeps the most-recently-inserted entry, even if oversized', () => {
    const m = new MemBytes(100);
    m.put('a', buf(40));
    m.put('big', buf(500)); // larger than the whole budget
    expect(m.get('big')?.length).toBe(500);
    expect(m.get('a')).toBeUndefined(); // evicted to make room
    expect(m.bytes).toBe(500);
  });

  it('overwriting a key updates the total, not duplicates it', () => {
    const m = new MemBytes(null);
    m.put('a', buf(10));
    m.put('a', buf(25));
    expect(m.bytes).toBe(25);
    expect(m.get('a')?.length).toBe(25);
  });

  it('delete and clear free their bytes', () => {
    const m = new MemBytes(null);
    m.put('a', buf(10));
    m.put('b', buf(20));
    m.delete('a');
    expect(m.get('a')).toBeUndefined();
    expect(m.bytes).toBe(20);
    m.clear();
    expect(m.bytes).toBe(0);
    expect(m.get('b')).toBeUndefined();
  });
});
