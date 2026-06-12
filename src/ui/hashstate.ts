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

/** Navigate to a view, preserving the current params. Fires hashchange. */
export function setView(view: string): void {
  const { params } = readHash();
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

export function getParam(name: string): string | null {
  return readHash().params.get(name);
}

/** `w=t0-t1` ⇄ [t0, t1] */
export function parseWindowParam(value: string | null): [number, number] | null {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  const t0 = parseInt(match[1], 10);
  const t1 = parseInt(match[2], 10);
  return t1 > t0 ? [t0, t1] : null;
}

export function windowParam(window: [number, number] | null): string | null {
  return window ? `${Math.round(window[0])}-${Math.round(window[1])}` : null;
}
