/**
 * Time-range specs for the scanbar (SPEC §6.0). A range is either an explicit
 * absolute window (from/to epoch-ms, handled directly by the scanbar) or a
 * RELATIVE spec that re-resolves against the wall clock: a rolling "last N
 * units", or a named range (today, this-week, …). Relative specs live in the
 * URL as `range=<token>` and keep their resolved [start, end] sliding as time
 * passes; absolute ranges stay as `from`/`to`.
 *
 * Named ranges snap to the DISPLAYED zone's midnight (the masthead UTC toggle),
 * so "today" matches the clock the user sees. Pure + unit-tested; the scanbar
 * owns the active spec and the auto-refresh.
 */

export type TimeUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';
export type NamedRange =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month';

export type RangeSpec =
  | { kind: 'last'; amount: number; unit: TimeUnit }
  | { kind: 'named'; name: NamedRange };

const DAY_MS = 86_400_000;
const UNIT_MS: Record<TimeUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: DAY_MS,
  weeks: 7 * DAY_MS,
  // a fixed 30-day approximation — the calendar month is the named `this-month`
  months: 30 * DAY_MS,
};

export const TIME_UNITS: TimeUnit[] = ['minutes', 'hours', 'days', 'weeks', 'months'];

export const NAMED_RANGES: { name: NamedRange; label: string }[] = [
  { name: 'today', label: 'Today' },
  { name: 'yesterday', label: 'Yesterday' },
  { name: 'this-week', label: 'This week' },
  { name: 'last-week', label: 'Last week' },
  { name: 'this-month', label: 'This month' },
  { name: 'last-month', label: 'Last month' },
];

// ----------------------------------- zone-aware day/week/month boundaries ---
// `utc` = the displayed zone is UTC; otherwise the browser's local zone (the
// same toggle fmtDate/zoneLabel read).

function startOfDay(now: number, utc: boolean): number {
  const d = new Date(now);
  if (utc) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeek(now: number, utc: boolean): number {
  const dow = utc ? new Date(now).getUTCDay() : new Date(now).getDay();
  const sinceMonday = (dow + 6) % 7; // Monday = week start
  return startOfDay(now, utc) - sinceMonday * DAY_MS;
}
function startOfMonth(now: number, utc: boolean, monthsBack = 0): number {
  const d = new Date(now);
  return utc
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1)
    : new Date(d.getFullYear(), d.getMonth() - monthsBack, 1).getTime();
}

/** Resolve a spec to a concrete [start, end] window at `now`. */
export function resolveRange(spec: RangeSpec, now: number, utc: boolean): [number, number] {
  if (spec.kind === 'last') return [now - spec.amount * UNIT_MS[spec.unit], now];
  switch (spec.name) {
    case 'today':
      return [startOfDay(now, utc), now];
    case 'yesterday':
      return [startOfDay(now, utc) - DAY_MS, startOfDay(now, utc) - 1];
    case 'this-week':
      return [startOfWeek(now, utc), now];
    case 'last-week': {
      const w = startOfWeek(now, utc);
      return [w - 7 * DAY_MS, w - 1];
    }
    case 'this-month':
      return [startOfMonth(now, utc), now];
    case 'last-month':
      return [startOfMonth(now, utc, 1), startOfMonth(now, utc) - 1];
  }
}

// ------------------------------------------------------ URL token <-> spec ---

/** A compact, readable URL token: `last-1.5-hours`, `today`, `this-week`. */
export function rangeToken(spec: RangeSpec): string {
  return spec.kind === 'last' ? `last-${spec.amount}-${spec.unit}` : spec.name;
}

const LAST_RE = /^last-(\d+(?:\.\d+)?)-(minutes|hours|days|weeks|months)$/;

/** Parse a `range=` token back to a spec, or null if it isn't a known one. */
export function parseRangeToken(token: string | null | undefined): RangeSpec | null {
  if (!token) return null;
  const named = NAMED_RANGES.find((r) => r.name === token);
  if (named) return { kind: 'named', name: named.name };
  const m = LAST_RE.exec(token);
  if (m) {
    const amount = parseFloat(m[1]);
    if (amount > 0 && isFinite(amount)) return { kind: 'last', amount, unit: m[2] as TimeUnit };
  }
  return null;
}

// --------------------------------------------------------------- display ---

/** Human label for the pill / recents: "Last 1.5 hours", "This week". */
export function rangeLabel(spec: RangeSpec): string {
  if (spec.kind === 'named') return NAMED_RANGES.find((r) => r.name === spec.name)!.label;
  const unit = spec.amount === 1 ? spec.unit.replace(/s$/, '') : spec.unit;
  return `Last ${spec.amount} ${unit}`;
}
