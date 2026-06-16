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

/**
 * Optional deploy-configured apex. A self-host whose apex is itself a sub-level
 * — e.g. `tracelog.example.com`, where the registrable domain `example.com`
 * would be wrong — declares it with `<meta name="tracelog:apex" content="…">`
 * in index.html, stamped there by `deploy-site.mjs --domain`. Read once and
 * synchronously: the workspace boot redirects before first render, so there's
 * no time for an async fetch. An absent/empty tag — and the unreplaced
 * `__TRACELOG_APEX__` placeholder (no dot) — both read as null, i.e. "fall back
 * to the registrable domain", which keeps `tracelog.org` zero-config.
 */
let apexOverride: string | null | undefined;
export function configuredApex(): string | null {
  if (apexOverride === undefined) {
    const raw =
      typeof document !== 'undefined'
        ? document.querySelector('meta[name="tracelog:apex"]')?.getAttribute('content')
        : null;
    const v = (raw ?? '').trim().toLowerCase();
    apexOverride = v.includes('.') ? v : null;
  }
  return apexOverride;
}

/**
 * The deployment apex for `host`: the configured override when it actually
 * covers this host (the host *is* the apex or a subdomain of it), otherwise the
 * registrable domain. This — not `registrableDomain` directly — is the apex the
 * workspace model keys on. `configured` is injectable for tests.
 */
export function siteApex(host: string, configured: string | null = configuredApex()): string {
  if (configured && (host === configured || host.endsWith(`.${configured}`))) return configured;
  return registrableDomain(host);
}

/** Whether two hostnames share a deployment apex (same site, incl. sibling
 *  subdomains) — e.g. `a.example.com` and `b.example.com`. Honors a configured
 *  apex, so a sibling outside it (`evil.example.com` vs `a.tracelog.example.com`)
 *  is correctly *not* same-site. */
export function sameSite(a: string, b: string): boolean {
  return a === b || siteApex(a) === siteApex(b);
}
