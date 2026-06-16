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
  // the IANA zone's final segment, e.g. 'America/New_York' → 'New York' (never
  // "local" — that reads as the user's own time, which is a separate concept)
  const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) return tz.split('/').pop()!.replace(/_/g, ' ');
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  return `GMT${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
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

/**
 * A timestamp rendered no finer than a chart's bar width (SPEC §7): daily bars
 * show just the date, hourly bars the hour, minute bars the minute, and so on —
 * so a 1h bucket reads "Jun 10, 2 PM" rather than "…14:00:00.000". Humane
 * (abbreviated month, 12-hour clock, year dropped when it's the current year)
 * and zone-aware.
 */
export function fmtScaleTime(ms: number, scaleMs: number): string {
  const d = new Date(ms);
  const mo = utcMode ? d.getUTCMonth() : d.getMonth();
  const day = utcMode ? d.getUTCDate() : d.getDate();
  const y = utcMode ? d.getUTCFullYear() : d.getFullYear();
  const ref = new Date();
  const refY = utcMode ? ref.getUTCFullYear() : ref.getFullYear();
  let date = `${MONTHS[mo]} ${day}`;
  if (y !== refY) date += `, ${y}`;
  if (scaleMs >= 86_400_000) return date; // daily+ bars → date only

  const h = utcMode ? d.getUTCHours() : d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ap = h < 12 ? 'am' : 'pm';
  if (scaleMs >= 3_600_000) return `${date}, ${h12}${ap}`; // hourly → the hour
  const mi = utcMode ? d.getUTCMinutes() : d.getMinutes();
  if (scaleMs >= 60_000) return `${date}, ${h12}:${pad2(mi)}${ap}`; // → the minute
  const s = utcMode ? d.getUTCSeconds() : d.getSeconds();
  return `${date}, ${h12}:${pad2(mi)}:${pad2(s)}${ap}`; // sub-minute → the second
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

/**
 * bytes → coarse units for at-a-glance readouts (`4.0 GB` / `412 KB`): one
 * decimal below 10 so a single-digit value never reads as a bare integer,
 * whole numbers at 10+.
 */
export function fmtBytesRough(bytes: number): string {
  const unit = (v: number): string => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  if (bytes >= 1024 * 1024 * 1024) return `${unit(bytes / (1024 * 1024 * 1024))} GB`;
  if (bytes >= 1024 * 1024) return `${unit(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${unit(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** counts with comma grouping: 12,345 */
export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

// ── value-axis tick formatting ──────────────────────────────────────────────
// A chart's y-axis labels read best when they agree: one unit for the whole
// axis (not "min" on one line and "µs" on the zero line), only as many decimals
// as it takes to tell the ticks apart ("83 min", not the noise of "83.3 min"),
// and no label at all on a zero origin. These build a tick formatter from the
// FULL tick set so it can pick that shared unit/precision. LINEAR axes only —
// a log axis spans units by decade on purpose and has no zero, so it keeps
// per-tick formatting.

/**
 * Decimal places for a set of evenly-spaced axis values. We start from a cap
 * that gives the tick STEP ~two significant figures — so a step of 16.67
 * collapses to whole numbers (the ".67" is noise) while a step of 0.25 keeps two
 * places — then trim to the fewest decimals that still reproduce every tick at
 * that cap (so integer steps like 5, 10, 15 don't print a pointless ".0").
 */
function axisDecimals(values: number[], step: number): number {
  if (!(step > 0)) return 0;
  const cap = Math.min(3, Math.max(0, Math.ceil(1 - Math.log10(step))));
  for (let d = 0; d < cap; d++) {
    if (values.every((v) => Number(v.toFixed(d)) === Number(v.toFixed(cap)))) return d;
  }
  return cap;
}

type Unit = [div: number, label: string];
const DURATION_UNITS: Unit[] = [[60_000, 'min'], [1000, 's'], [1, 'ms'], [0.001, 'µs']];
const BYTE_UNITS: Unit[] = [[1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB'], [1, 'B']];

function unitAxisFormat(ticks: number[], units: Unit[]): (v: number) => string {
  const max = ticks.reduce((m, t) => Math.max(m, Math.abs(t)), 0);
  const [div, label] = units.find(([d]) => max >= d) ?? units[units.length - 1];
  const vals = ticks.map((t) => t / div);
  const sorted = [...vals].sort((a, b) => a - b);
  const step =
    sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) : sorted[0];
  const dec = axisDecimals(vals, step);
  return (v) => (v === 0 ? '' : `${(v / div).toFixed(dec)} ${label}`);
}

/** Consistent-unit, minimal-precision, zero-omitting formatter for a LINEAR
 *  duration axis (millisecond domain). Pass the axis's full tick set. */
export function durationAxisFormat(ticks: number[]): (ms: number) => string {
  return unitAxisFormat(ticks, DURATION_UNITS);
}

/** As durationAxisFormat, for a linear bytes axis. */
export function bytesAxisFormat(ticks: number[]): (bytes: number) => string {
  return unitAxisFormat(ticks, BYTE_UNITS);
}

/** Wrap a scalar formatter to leave a zero origin unlabelled — for single-unit
 *  axes (counts, percentages) that need no unit unification. */
export function omitZero(fmt: (v: number) => string): (v: number) => string {
  return (v) => (v === 0 ? '' : fmt(v));
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Humane timestamps: "30 seconds ago", "12 minutes ago", "4:30p" (today),
 * "yesterday", "June 3", "June 3, 2025". Day boundaries and clock time
 * respect the active zone (UTC toggle).
 */
export function fmtHumane(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 0) return fmtDateTime(ms); // future: be literal
  if (diff < 60_000) {
    const s = Math.max(1, Math.round(diff / 1000));
    return s === 1 ? '1 second ago' : `${s} seconds ago`;
  }
  if (diff < 60 * 60_000) {
    const m = Math.round(diff / 60_000);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }

  const d = new Date(ms);
  const ref = new Date(now);
  const dayStart = (x: Date) =>
    utcMode
      ? Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
      : new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(ref) - dayStart(d)) / 86_400_000);

  if (dayDiff === 0) {
    const h24 = utcMode ? d.getUTCHours() : d.getHours();
    const min = utcMode ? d.getUTCMinutes() : d.getMinutes();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(min).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`;
  }
  if (dayDiff === 1) return 'yesterday';

  const month = MONTHS[utcMode ? d.getUTCMonth() : d.getMonth()];
  const dayOfMonth = utcMode ? d.getUTCDate() : d.getDate();
  const year = utcMode ? d.getUTCFullYear() : d.getFullYear();
  const refYear = utcMode ? ref.getUTCFullYear() : ref.getFullYear();
  return year === refYear ? `${month} ${dayOfMonth}` : `${month} ${dayOfMonth}, ${year}`;
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
