/**
 * Workspace directory (SPEC §4, §10) — navigation-based, no iframe.
 *
 * Each `*.tracelog.org` subdomain is a separate, siloed browser origin. The
 * one thing shared across them is a directory of workspace *names*, kept in
 * the APEX origin's first-party localStorage. Subdomains never reach into
 * the apex's storage directly (no cross-origin iframe, nothing an ad-blocker
 * or privacy mode can impede); instead they *navigate* to the apex's relay
 * route, which does the read/write first-party and bounces straight back.
 * Every subdomain keeps a local cached snapshot for instant, flicker-free
 * switcher hops; it's refreshed on each apex transit (create, delete, the
 * first-visit auto-sync, or an explicit sync).
 *
 * The directory is inherently per-device — localStorage isn't shared across
 * machines and there is no server — so the only thing that ever mutates it
 * is this browser creating or deleting a workspace.
 */

export interface WorkspaceContext {
  /** registrable apex, e.g. 'tracelog.org'; null when there's no apex to use */
  apexHost: string | null;
  /** current subdomain label, e.g. 'duiduidui'; '' on the apex itself */
  current: string;
  /** origin of the apex (relay + directory home); null = no apex */
  apexOrigin: string | null;
}

/** apex directory (only valid while physically at the apex origin) */
const DIRECTORY_KEY = 'tracelog:directory';
/** per-origin cached snapshot of the directory (for the switcher) */
const CACHE_KEY = 'tracelog:workspaces-cache';
/** per-origin flag: this subdomain has done its first-visit sync */
const SYNCED_KEY = 'tracelog:synced';

/** Valid subdomain label (or dotted nesting); keeps relay params clean/safe. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
export function validLabel(label: string): boolean {
  return label.length > 0 && label.length <= 100 && LABEL_RE.test(label);
}

function isBareHost(host: string): boolean {
  return host === 'localhost' || /^[\d.]+$/.test(host) || !host.includes('.');
}

export function workspaceContext(): WorkspaceContext {
  const host = location.hostname;
  if (isBareHost(host)) return { apexHost: null, current: '', apexOrigin: null };
  const parts = host.split('.');
  const apexHost = parts.slice(-2).join('.');
  const current = parts.length > 2 ? parts.slice(0, -2).join('.') : '';
  return { apexHost, current, apexOrigin: `${location.protocol}//${apexHost}` };
}

/** The https URL a workspace (subdomain) lives at. */
export function workspaceUrl(label: string): string {
  const { apexHost } = workspaceContext();
  return `https://${label}.${apexHost}/`;
}

/**
 * On the bare apex of a real domain — the public landing + directory keeper,
 * which is NOT itself a workspace (no profiles, no data live here). False on
 * subdomains and on localhost/self-host single-origin.
 */
export function isApexHome(): boolean {
  const c = workspaceContext();
  return c.apexHost !== null && c.current === '';
}

/**
 * Workspaces to show in the switcher. At the apex we read the live directory
 * first-party; on a subdomain we read this origin's cached snapshot.
 */
export function knownWorkspaces(): string[] {
  const c = workspaceContext();
  if (!c.apexHost) return [];
  return c.current === '' ? directory() : cachedWorkspaces();
}

// --------------------------------------------------------- local snapshot

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled — degrade to re-syncing on next load */
  }
}

/** This origin's cached directory snapshot, current workspace excluded. */
export function cachedWorkspaces(): string[] {
  const raw = safeGet(CACHE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function cacheWorkspaces(names: string[]): void {
  safeSet(CACHE_KEY, JSON.stringify([...new Set(names)].filter(Boolean).sort()));
}

export function isSynced(): boolean {
  return safeGet(SYNCED_KEY) === '1';
}

// --------------------------------------------------------- apex directory
// (only call these while at the apex origin — i.e. inside the relay)

function directory(): string[] {
  const raw = safeGet(DIRECTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}
function writeDirectory(names: string[]): void {
  safeSet(DIRECTORY_KEY, JSON.stringify([...new Set(names)].filter(Boolean).sort().slice(0, 256)));
}

// ------------------------------------------------------------- the relay
//
// Boot order (handleRelayBoot): (1) absorb a relay RETURN, (2) if we ARE the
// apex serving a relay request, do the op + bounce back, (3) first-visit
// auto-sync. Returns true when it has taken over the page (a redirect is in
// flight or about to be), so the app skips normal rendering.

interface RelayParams {
  op: 'sync' | 'add' | 'remove';
  ws: string; // target label for add/remove ('' for sync)
  from: string; // host that initiated (return destination for sync/remove)
  view: string; // hash view to land on
}

function hashQuery(): URLSearchParams {
  const h = location.hash.replace(/^#/, '');
  const q = h.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : h.slice(q + 1));
}

function hashView(): string {
  const h = location.hash.replace(/^#/, '');
  const q = h.indexOf('?');
  return (q === -1 ? h : h.slice(0, q)) || '/';
}

function interstitial(): void {
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;display:flex;align-items:center;' +
    'justify-content:center;font:14px system-ui;color:#7c7973">Setting up workspace…</div>';
}

/**
 * Apply a directory op (we must be at the apex, first-party) and return the
 * URL to land on next — the new subdomain for `add`, or back to `from` for
 * `sync`/`remove` — carrying a fresh snapshot. null if the destination
 * isn't same-site (don't redirect off-site).
 */
function applyApexOp(op: string, ws: string, from: string, apexHost: string, view: string): string | null {
  if (op === 'add' && validLabel(ws)) writeDirectory([...directory(), ws]);
  else if (op === 'remove' && validLabel(ws)) writeDirectory(directory().filter((n) => n !== ws));
  const destHost = op === 'add' && validLabel(ws) ? `${ws}.${apexHost}` : from;
  if (destHost !== apexHost && !destHost.endsWith(`.${apexHost}`)) return null;
  const back = new URLSearchParams({ wsl: directory().join(','), wsr: '1' });
  return `https://${destHost}/#${view}?${back.toString()}`;
}

/**
 * Run a directory op via the apex. From a subdomain we navigate (cross-
 * origin) to the apex relay, which re-runs this logic first-party on load.
 * From the apex itself we're already first-party — so do it inline and go
 * straight to the destination (navigating to our own `#/relay` would be a
 * hash-only change that never reloads, so the relay would never run).
 */
function gotoRelay(op: RelayParams['op'], ws: string, view: string): void {
  const ctx = workspaceContext();
  if (!ctx.apexOrigin || !ctx.apexHost) return;
  if (ctx.current === '') {
    const dest = applyApexOp(op, ws, location.host, ctx.apexHost, view);
    if (dest) {
      interstitial();
      location.assign(dest);
    }
    return;
  }
  const qs = new URLSearchParams({ op, ws, from: location.host, view });
  interstitial();
  location.assign(`${ctx.apexOrigin}/#/relay?${qs.toString()}`);
}

/**
 * Run on boot and before normal routing. Returns true if it has taken over
 * (a navigation is happening) and the app should not render its view.
 */
export function handleWorkspaceBoot(): boolean {
  const ctx = workspaceContext();
  if (!ctx.apexHost) return false; // localhost / self-host single-origin: no directory

  const params = hashQuery();

  // (1) Absorb a relay RETURN: cache the list, mark synced, strip the
  //     markers, and let normal routing render the carried view. The `wsr`
  //     one-shot marker also guarantees we never re-bounce on this load.
  if (params.get('wsr') === '1') {
    const list = (params.get('wsl') ?? '').split(',').filter(Boolean);
    cacheWorkspaces(list);
    safeSet(SYNCED_KEY, '1');
    params.delete('wsr');
    params.delete('wsl');
    const view = hashView();
    const rest = params.toString();
    history.replaceState(null, '', `#${view}${rest ? `?${rest}` : ''}`);
    return false; // proceed to render `view`
  }

  // (2) We ARE the apex, serving a relay request: do the op first-party,
  //     then bounce to the destination with a fresh snapshot.
  if (ctx.current === '' && hashView() === '/relay') {
    const dest = applyApexOp(
      params.get('op') ?? '',
      params.get('ws') ?? '',
      params.get('from') ?? '',
      ctx.apexHost,
      params.get('view') || '/overview',
    );
    if (!dest) {
      history.replaceState(null, '', '#/about'); // off-site dest: refuse, show home
      return false;
    }
    interstitial();
    location.assign(dest);
    return true;
  }

  // (3) First visit to a fresh subdomain → read-only auto-sync.
  if (ctx.current !== '' && !isSynced()) {
    gotoRelay('sync', '', hashView());
    return true;
  }

  return false;
}

// ------------------------------------------------ actions the UI triggers

/** Create a workspace: record it at the apex, then land on its config. */
export function createWorkspace(label: string): void {
  gotoRelay('add', label, '/config');
}

/**
 * Record the current workspace in the directory if it isn't already there
 * (a profile was just saved on a subdomain reached by direct navigation
 * rather than the create flow). Returns true if a bounce is in flight.
 */
export function recordCurrentWorkspaceIfNew(returnView: string): boolean {
  const { current } = workspaceContext();
  if (!current || cachedWorkspaces().includes(current)) return false;
  gotoRelay('add', current, returnView);
  return true;
}

/** Drop the current workspace from the directory (its last profile is gone). */
export function dropCurrentWorkspace(returnView: string): void {
  const { current } = workspaceContext();
  if (current) gotoRelay('remove', current, returnView);
}

/** Refresh this origin's cached snapshot from the apex (manual sync). */
export function syncWorkspaces(returnView: string): void {
  gotoRelay('sync', '', returnView);
}

/** Forget this origin's directory cache + synced flag (part of a full purge). */
export function clearLocalWorkspaceState(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(SYNCED_KEY);
  } catch {
    /* storage disabled */
  }
}
