import { describe, it, expect } from 'vitest';
import { registrableDomain, sameSite } from './domain';

describe('registrableDomain', () => {
  it('returns the host unchanged for one- or two-label names', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('localhost')).toBe('localhost');
  });

  it('strips subdomains to the last two labels for single-label TLDs', () => {
    expect(registrableDomain('a.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.c.example.org')).toBe('example.org');
    expect(registrableDomain('demo.tracelog.org')).toBe('tracelog.org');
  });

  it('keeps three labels for known multi-part public suffixes', () => {
    expect(registrableDomain('a.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('shop.foo.com.au')).toBe('foo.com.au');
    expect(registrableDomain('w.bar.co.jp')).toBe('bar.co.jp');
  });

  it('falls back to two labels for unknown multi-part TLDs', () => {
    expect(registrableDomain('a.example.xyz.zz')).toBe('xyz.zz');
  });
});

describe('sameSite', () => {
  it('matches sibling subdomains on the same apex', () => {
    expect(sameSite('a.tracelog.org', 'b.tracelog.org')).toBe(true);
    expect(sameSite('demo.tracelog.org', 'tracelog.org')).toBe(true);
    expect(sameSite('a.foo.co.uk', 'b.foo.co.uk')).toBe(true);
  });

  it('rejects different sites', () => {
    expect(sameSite('a.tracelog.org', 'evil.com')).toBe(false);
    // the co.uk fix: two different orgs under co.uk are NOT the same site
    expect(sameSite('a.foo.co.uk', 'b.bar.co.uk')).toBe(false);
  });

  it('treats identical hosts as same-site', () => {
    expect(sameSite('localhost', 'localhost')).toBe(true);
  });
});
