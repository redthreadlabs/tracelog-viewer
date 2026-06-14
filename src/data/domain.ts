/**
 * Registrable-domain ("apex") computation. Most TLDs register at one label
 * (foo.example.com → example.com), but some ccTLDs register at the second level
 * (foo.example.co.uk → example.co.uk). The fully-correct answer needs the
 * Public Suffix List (~30 KB); for a client-side tool we special-case the
 * common multi-part suffixes instead and fall back to the last two labels
 * otherwise — correct for the vast majority of real deployments.
 *
 * Used both to derive a workspace's apex (subdomain ⇄ apex relay) and to decide
 * whether a referrer is intra-site (same apex, incl. sibling-subdomain
 * workspaces).
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'net.za',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'co.il', 'co.id', 'co.th', 'com.my', 'com.ph', 'com.vn',
  'com.pl', 'com.ua', 'co.ke', 'com.co', 'co.cr',
]);

/** The registrable domain (apex) for a hostname, e.g.
 *  `a.b.example.co.uk` → `example.co.uk`, `a.example.com` → `example.com`. */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Whether two hostnames share a registrable domain (same site, incl. sibling
 *  subdomains) — e.g. `a.example.com` and `b.example.com`. */
export function sameSite(a: string, b: string): boolean {
  return a === b || registrableDomain(a) === registrableDomain(b);
}
