/**
 * Bar-width chooser for time-bucketed charts. The choice lives in the hash
 * (`b=1h`) so it shares like everything else and applies consistently to
 * every bucketed chart. "auto" picks a width for the span (and an explicit
 * choice still escalates rather than draw thousands of bars — see
 * resolveBucketMs).
 */
import { el } from './dom';
import { getParam, setParams } from './hashstate';

export const BUCKET_CHOICES: { token: string; label: string; ms: number | null }[] = [
  { token: 'auto', label: 'auto', ms: null },
  { token: '1m', label: '1 min', ms: 60_000 },
  { token: '5m', label: '5 min', ms: 300_000 },
  { token: '15m', label: '15 min', ms: 900_000 },
  { token: '1h', label: '1 hour', ms: 3_600_000 },
  { token: '3h', label: '3 hours', ms: 3 * 3_600_000 },
  { token: '6h', label: '6 hours', ms: 6 * 3_600_000 },
  { token: '1d', label: '1 day', ms: 24 * 3_600_000 },
];

export function chosenBucketMs(): number | null {
  const token = getParam('b');
  return BUCKET_CHOICES.find((c) => c.token === token)?.ms ?? null;
}

/** Label for an effective width, e.g. to show what "auto" resolved to. */
export function bucketLabel(ms: number): string {
  return BUCKET_CHOICES.find((c) => c.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`;
}

export function renderBucketPicker(onChange: () => void): HTMLElement {
  const select = el('select', { className: 'select select-pill', title: 'bar width' });
  const current = getParam('b') ?? 'auto';
  for (const choice of BUCKET_CHOICES) {
    select.append(el('option', { text: choice.label, attrs: { value: choice.token } }));
  }
  select.value = BUCKET_CHOICES.some((c) => c.token === current) ? current : 'auto';
  select.addEventListener('change', () => {
    setParams({ b: select.value === 'auto' ? null : select.value });
    onChange();
  });
  return select;
}
