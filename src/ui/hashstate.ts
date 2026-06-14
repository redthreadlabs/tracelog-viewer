/**
 * Shareable hash-URLs (SPEC M4): the hash carries the view plus a query
 * string encoding scan + view state, e.g.
 *
 *   #/events?ch=server,client&from=2026-06-10&to=2026-06-12&w=t0-t1&user=u1
 *
 * View changes assign location.hash (and fire hashchange → route); state
 * changes use history.replaceState, which updates the URL silently without
 * re-rendering or polluting history while typing.
 */

export interface HashState {
  view: string;
  params: URLSearchParams;
}

export function readHash(): HashState {
  const h = location.hash.replace(/^#/, '');
  const qIdx = h.indexOf('?');
  const view = (qIdx === -1 ? h : h.slice(0, qIdx)) || '/overview';
  const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
  return { view, params };
}

/**
 * Params that only mean something on certain views: dropped when
 * navigating anywhere else, so a filter set on Events doesn't lurk in
 * every URL copied afterwards (`user=` outliving its page). Global params
 * (ch, from, to, w, b) always travel.
 */
const SCOPED_PARAMS: Record<string, (view: string) => boolean> = {
  q: (view) => view === '/records' || view === '/events',
  user: (view) => view === '/events',
  type: (view) => view === '/events',
};

/**
 * Navigate to a view, preserving the params that apply there. Fires
 * hashchange. (The back button still restores old URLs verbatim — scoping
 * only shapes *forward* navigation.)
 */
export function setView(view: string): void {
  const { params } = readHash();
  for (const [key, appliesTo] of Object.entries(SCOPED_PARAMS)) {
    if (params.has(key) && !appliesTo(view)) params.delete(key);
  }
  const qs = params.toString();
  const next = `#${view}${qs ? '?' + qs : ''}`;
  if (location.hash === next) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = next;
  }
}

/**
 * Merge param updates into the URL silently. null/undefined deletes a key;
 * an empty string is a real value (`ch=` means "no channels", while an
 * absent `ch` means "all channels") — callers that mean "remove" normalize
 * to null (`filters.search || null`).
 */
export function setParams(updates: Record<string, string | null | undefined>): void {
  const { view, params } = readHash();
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  history.replaceState(null, '', `#${view}${qs ? '?' + qs : ''}`);
}

/**
 * Like setParams, but pushes a NEW history entry — for a deliberate navigation
 * (brushing the chart to a new range) so the browser Back button returns to the
 * prior range. A depth counter in history.state lets the UI tell whether a Back
 * step stays within the app (vs. leaving the site).
 */
export function pushParams(updates: Record<string, string | null | undefined>): void {
  const { view, params } = readHash();
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  const depth = ((history.state as { tlDepth?: number } | null)?.tlDepth ?? 0) + 1;
  history.pushState({ tlDepth: depth }, '', `#${view}${qs ? '?' + qs : ''}`);
}

/** Whether the current history entry was pushed by us (so Back stays in-app). */
export function canGoBack(): boolean {
  return ((history.state as { tlDepth?: number } | null)?.tlDepth ?? 0) > 0;
}

/**
 * Dispatched after a pushParams range change so the scanbar adopts the new
 * range WITHOUT a full view re-mount — a synthetic `hashchange` would re-route
 * (teardown + re-render the whole view). Back/Forward fire real hashchange.
 */
export const RANGE_NAV_EVENT = 'tracelog:rangenav';

export function getParam(name: string): string | null {
  return readHash().params.get(name);
}

/** `w=t0-t1` ⇄ [t0, t1] */
export function parseRangeParam(value: string | null): [number, number] | null {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  const t0 = parseInt(match[1], 10);
  const t1 = parseInt(match[2], 10);
  return t1 > t0 ? [t0, t1] : null;
}

export function rangeParam(range: [number, number] | null): string | null {
  return range ? `${Math.round(range[0])}-${Math.round(range[1])}` : null;
}
