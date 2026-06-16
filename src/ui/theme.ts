/**
 * Light/dark theme switching (SPEC §7): defaults to prefers-color-scheme,
 * manual toggle persists. All colors live in CSS custom properties, so flipping
 * the data-theme attribute re-skins the whole app via the cascade — no DOM
 * rebuild. The one exception is the d3 charts, which bake computed token hex
 * into SVG/canvas attributes the cascade can't reach; they listen for
 * THEME_CHANGE_EVENT and redraw in place (preserving their view state, e.g. the
 * overview's row selection — which a full re-mount would wipe).
 */

const STORAGE_KEY = 'tracelog-viewer:theme';

/** Fired after a manual theme toggle so chart views can recolor in place. */
export const THEME_CHANGE_EVENT = 'tracelog:themechange';

export type Theme = 'light' | 'dark';

export function initTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  const theme: Theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  apply(theme);
  return theme;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  apply(next);
  localStorage.setItem(STORAGE_KEY, next);
  // the cascade re-skins all CSS-driven color the instant the attribute flips;
  // this nudge is only for the d3 charts, which must redraw to re-read tokens
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  return next;
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
