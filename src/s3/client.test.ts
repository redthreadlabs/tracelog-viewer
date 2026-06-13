import { describe, it, expect } from 'vitest';
import { normalizePrefix as norm } from './client';

describe('normalizePrefix — silently canonicalizes any slashes', () => {
  it('empty/blank → bucket root', () => {
    expect(norm(undefined)).toBe('');
    expect(norm('')).toBe('');
    expect(norm('   ')).toBe('');
    expect(norm('/')).toBe('');
    expect(norm('///')).toBe('');
  });
  it('single segment → one trailing slash', () => {
    expect(norm('logs')).toBe('logs/');
    expect(norm('/logs')).toBe('logs/');
    expect(norm('logs/')).toBe('logs/');
    expect(norm('//logs//')).toBe('logs/');
    expect(norm('  logs  ')).toBe('logs/');
  });
  it('nested segments → collapsed, one trailing slash', () => {
    expect(norm('logs/prod')).toBe('logs/prod/');
    expect(norm('/logs//prod/')).toBe('logs/prod/');
    expect(norm('a/b/c')).toBe('a/b/c/');
  });
});
