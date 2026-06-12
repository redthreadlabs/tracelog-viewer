/**
 * Light/dark theme switching (SPEC §7): defaults to prefers-color-scheme,
 * manual toggle persists. All colors live in CSS custom properties; this
 * module only flips the data-theme attribute.
 */

const STORAGE_KEY = 'tracelog-viewer:theme';

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
  return next;
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
