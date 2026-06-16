/**
 * Aggregation-period chooser for time-series charts. The choice lives in the
 * hash (`period=1h`) so it shares like everything else and applies consistently
 * to every time-series chart. "auto" picks a period for the span (and an explicit
 * choice still escalates rather than draw thousands of bars — see
 * resolvePeriodMs).
 */
import { getParam } from './hashstate';

export const PERIOD_CHOICES: { token: string; label: string; ms: number | null }[] = [
  { token: 'auto', label: 'auto', ms: null },
  { token: '1m', label: '1 min', ms: 60_000 },
  { token: '5m', label: '5 min', ms: 300_000 },
  { token: '15m', label: '15 min', ms: 900_000 },
  { token: '1h', label: '1 hour', ms: 3_600_000 },
  { token: '3h', label: '3 hours', ms: 3 * 3_600_000 },
  { token: '6h', label: '6 hours', ms: 6 * 3_600_000 },
  { token: '1d', label: '1 day', ms: 24 * 3_600_000 },
];

export function chosenPeriodMs(): number | null {
  const token = getParam('period');
  return PERIOD_CHOICES.find((c) => c.token === token)?.ms ?? null;
}

/** Label for an effective width, e.g. to show what "auto" resolved to. */
export function periodLabel(ms: number): string {
  return PERIOD_CHOICES.find((c) => c.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`;
}
