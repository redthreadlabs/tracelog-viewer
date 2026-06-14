/**
 * A pill-dropdown multiselect: a compact pill showing a selection summary
 * ("all" / "none" / "3 of 8") that opens a checkbox list with All / None quick
 * actions. Used for the channel and host filters. Stateless — the caller owns
 * the open flag and the selected set, and re-renders on every change (the
 * scanbar's model); the popover self-prunes stale outside-click listeners.
 */
import { el } from './dom';

export interface MultiselectSpec {
  /** field name shown beside the pill, e.g. "Channels" */
  label: string;
  /** every available value (already sorted) */
  values: string[];
  /** the currently-selected subset */
  selected: Set<string>;
  /** whether the dropdown is open (caller-owned, survives re-renders) */
  open: boolean;
  /** toggle the dropdown open/closed */
  onToggleOpen: () => void;
  /** the selection changed — caller updates state + reloads */
  onChange: (selected: Set<string>) => void;
}

function summary(values: string[], selected: Set<string>): string {
  if (values.length === 0) return 'none available';
  const on = values.filter((v) => selected.has(v));
  if (on.length === 0) return 'none';
  if (on.length === values.length) return 'all';
  if (on.length === 1) return on[0];
  return `${on.length} of ${values.length}`;
}

export function renderMultiselect(spec: MultiselectSpec): HTMLElement {
  const group = el('div', { className: 'group multiselect-wrap' }, [
    el('span', { className: 'label', text: spec.label }),
  ]);

  const pill = el(
    'button',
    { className: spec.open ? 'chip multiselect-pill on' : 'chip multiselect-pill' },
    [el('span', { text: summary(spec.values, spec.selected) }), el('span', { className: 'caret', text: '▾' })],
  );
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    spec.onToggleOpen();
  });
  group.append(pill);

  if (!spec.open) return group;

  const pop = el('div', { className: 'multiselect-pop' });
  pop.append(
    el('div', { className: 'multiselect-actions' }, [
      el('button', {
        className: 'btn btn-quiet',
        text: 'All',
        on: { click: () => spec.onChange(new Set(spec.values)) },
      }),
      el('button', {
        className: 'btn btn-quiet',
        text: 'None',
        on: { click: () => spec.onChange(new Set()) },
      }),
    ]),
  );

  if (spec.values.length === 0) {
    pop.append(el('div', { className: 'faint multiselect-empty', text: 'none in range' }));
  }
  for (const v of spec.values) {
    const checkbox = el('input', { attrs: { type: 'checkbox' } });
    checkbox.checked = spec.selected.has(v);
    const row = el('label', { className: 'multiselect-row' }, [checkbox, el('span', { text: v })]);
    row.addEventListener('click', (e) => {
      e.preventDefault(); // we drive the checked state from `selected`
      const next = new Set(spec.selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      spec.onChange(next);
    });
    pop.append(row);
  }
  group.append(pop);

  // close on outside click; a stale listener (its pop replaced by a re-render)
  // simply unsubscribes itself, so only the live popover's listener acts
  setTimeout(() => {
    const onDown = (ev: MouseEvent) => {
      if (!pop.isConnected) {
        document.removeEventListener('mousedown', onDown);
        return;
      }
      if (!group.contains(ev.target as Node)) {
        document.removeEventListener('mousedown', onDown);
        spec.onToggleOpen();
      }
    };
    document.addEventListener('mousedown', onDown);
  }, 0);

  return group;
}
