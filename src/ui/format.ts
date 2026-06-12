/**
 * Shared formatters (SPEC §7): every chart and table agrees on how
 * durations, bytes, and times are written. Times render in local time by
 * default with a UTC toggle; the active zone is always labeled.
 */

let utcMode = false;

export function setUtcMode(utc: boolean): void {
  utcMode = utc;
}

export function isUtcMode(): boolean {
  return utcMode;
}

export function zoneLabel(): string {
  if (utcMode) return 'UTC';
  return new Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop() ?? 'local';
}

/** epoch-ms → `2026-06-12` (in the active zone) */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const y = utcMode ? d.getUTCFullYear() : d.getFullYear();
  const m = (utcMode ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utcMode ? d.getUTCDate() : d.getDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/** epoch-ms → `14:05:32.118` (in the active zone) */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = utcMode ? d.getUTCHours() : d.getHours();
  const m = utcMode ? d.getUTCMinutes() : d.getMinutes();
  const s = utcMode ? d.getUTCSeconds() : d.getSeconds();
  const f = utcMode ? d.getUTCMilliseconds() : d.getMilliseconds();
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(f).padStart(3, '0')}`;
}

export function fmtDateTime(ms: number): string {
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

/** duration in ms → `1.82 s` / `162 ms` / `840 µs` */
export function fmtDuration(ms: number): string {
  if (!isFinite(ms)) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms >= 100 ? Math.round(ms) : ms.toFixed(1)} ms`;
  return `${Math.round(ms * 1000)} µs`;
}

/** bytes → `3.2 MB` / `412 KB` / `97 B` */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** counts with thin-space grouping: 12 345 */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** today's interval label (UTC — tracelog intervals are UTC dates) */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** UTC date string N days before today */
export function utcDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
