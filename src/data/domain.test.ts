import { describe, it, expect } from 'vitest';
import { registrableDomain, sameSite, siteApex } from './domain';

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

describe('siteApex', () => {
  it('falls back to the registrable domain with no configured apex', () => {
    expect(siteApex('duiduidui.tracelog.org', null)).toBe('tracelog.org');
    expect(siteApex('tracelog.org', null)).toBe('tracelog.org');
  });

  it('uses a configured sub-level apex when it covers the host', () => {
    const apex = 'tracelog.example.com';
    // the apex itself
    expect(siteApex('tracelog.example.com', apex)).toBe(apex);
    // a workspace under it (the case the registrable domain gets wrong)
    expect(siteApex('duiduidui.tracelog.example.com', apex)).toBe(apex);
    // nested workspace label
    expect(siteApex('team.duiduidui.tracelog.example.com', apex)).toBe(apex);
  });

  it('ignores a configured apex that does not cover the host', () => {
    // a host outside the configured apex falls back to its registrable domain,
    // so it never collapses into the wrong site
    expect(siteApex('evil.example.com', 'tracelog.example.com')).toBe('example.com');
    expect(siteApex('other.org', 'tracelog.example.com')).toBe('other.org');
  });

  it('makes sameSite honor the configured apex boundary', () => {
    const apex = 'tracelog.example.com';
    expect(siteApex('a.tracelog.example.com', apex)).toBe(
      siteApex('b.tracelog.example.com', apex),
    );
    // a sibling outside the apex is NOT the same site
    expect(siteApex('a.tracelog.example.com', apex)).not.toBe(
      siteApex('evil.example.com', apex),
    );
  });
});
