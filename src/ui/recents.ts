/**
 * Recently-used ranges (SPEC §6.0), persisted in localStorage and re-read each
 * time the range popover opens. An entry is either a relative spec (`last …`,
 * `today`, …) or a specific absolute window. Newest first, deduped, capped.
 */
import type { RangeSpec } from './range';
import { rangeToken } from './range';

export type RecentRange =
  | { kind: 'spec'; spec: RangeSpec }
  | { kind: 'absolute'; from: number; to: number };

const KEY = 'tracelog:recent-ranges';
const CAP = 8;

/** Stable identity for dedup: same spec, or same absolute window. */
export function recentKey(r: RecentRange): string {
  return r.kind === 'spec' ? `s:${rangeToken(r.spec)}` : `a:${r.from}-${r.to}`;
}

/** Pure: prepend `entry`, drop any prior duplicate, cap the list (newest first). */
export function mergeRecent(list: RecentRange[], entry: RecentRange, cap = CAP): RecentRange[] {
  const key = recentKey(entry);
  return [entry, ...list.filter((r) => recentKey(r) !== key)].slice(0, cap);
}

function isRecent(x: unknown): x is RecentRange {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (r.kind === 'absolute') return typeof r.from === 'number' && typeof r.to === 'number';
  if (r.kind === 'spec') return !!r.spec && typeof r.spec === 'object';
  return false;
}

/** Read the saved list (newest first); [] if absent/unavailable/corrupt. */
export function loadRecents(): RecentRange[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter(isRecent) : [];
  } catch {
    return [];
  }
}

/** Record a just-applied range and return the new list. */
export function pushRecent(entry: RecentRange): RecentRange[] {
  const next = mergeRecent(loadRecents(), entry);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable / quota exceeded — non-fatal */
  }
  return next;
}
