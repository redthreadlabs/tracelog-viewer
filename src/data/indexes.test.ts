import { describe, it, expect } from 'vitest';
import { matchIndex, txnIndex } from './indexes';

const HOUR = 3_600_000;

describe('matchIndex', () => {
  it('matches the txn index for count/sum(duration) by transaction at an aligned ≥1h grid', () => {
    expect(matchIndex('sum', 'duration', 'transaction', HOUR, 0)).toBe(txnIndex);
    expect(matchIndex('count', undefined, 'transaction', HOUR, 0)).toBe(txnIndex);
    expect(matchIndex('sum', 'duration', 'transaction', 24 * HOUR, 0)).toBe(txnIndex);
  });

  it('declines a sub-hour or misaligned grid (hourly index can not resolve it)', () => {
    expect(matchIndex('sum', 'duration', 'transaction', 60_000, 0)).toBeUndefined(); // 1m bucket
    expect(matchIndex('sum', 'duration', 'transaction', HOUR, HOUR / 2)).toBeUndefined(); // :30 start
  });

  it('declines a metric it does not provide', () => {
    expect(matchIndex('sum', 'bytes', 'transaction', HOUR, 0)).toBeUndefined(); // wrong field
    expect(matchIndex('max', 'duration', 'transaction', HOUR, 0)).toBeUndefined(); // op not provided
    expect(matchIndex('avg', 'duration', 'transaction', HOUR, 0)).toBeUndefined(); // algebraic, not matched
    expect(matchIndex('sum', 'duration', 'host', HOUR, 0)).toBeUndefined(); // wrong groupBy
  });
});
