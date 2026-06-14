/**
 * A pill-dropdown multiselect: a compact pill showing a selection summary
 * ("all" / "none" / "3 of 8") that opens a checkbox list with All / None bulk
 * actions and an OK / Cancel footer. Used for the channel and host filters.
 *
 * Commit semantics (caller-driven): editing is local and deferred. ONLY OK
 * commits the pending selection; Cancel, tapping away, and Esc all REVERT it.
 * The component is stateless — the caller owns the open flag and the selected
 * set and re-renders on every change; the popover self-prunes stale listeners.
 */
import { el } from './dom';

export interface MultiselectSpec {
  /** field name shown beside the pill, e.g. "Channels" */
  label: string;
  /** every available value (already sorted) */
  values: string[];
  /** the (pending) selected subset */
  selected: Set<string>;
  /** whether the dropdown is open (caller-owned, survives re-renders) */
  open: boolean;
  /** the pill was clicked while closed → open + snapshot */
  onOpen: () => void;
  /** OK → apply the pending selection (load + history) */
  onCommit: () => void;
  /** Cancel / tap-away / Esc → revert to the snapshot */
  onCancel: () => void;
  /** a checkbox / All / None toggled — pending only, not yet applied */
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
    // clicking the pill while open closes WITHOUT applying (only OK commits)
    if (spec.open) spec.onCancel();
    else spec.onOpen();
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

  // only the option list scrolls — All/None (above) and Cancel/OK (below) stay
  // anchored, so you can end the interaction without scrolling to the bottom
  const list = el('div', { className: 'multiselect-list' });
  if (spec.values.length === 0) {
    list.append(el('div', { className: 'faint multiselect-empty', text: 'none in range' }));
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
    list.append(row);
  }
  pop.append(list);

  pop.append(
    el('div', { className: 'multiselect-footer' }, [
      el('button', { className: 'btn btn-quiet', text: 'Cancel', on: { click: () => spec.onCancel() } }),
      el('button', { className: 'btn btn-primary', text: 'OK', on: { click: () => spec.onCommit() } }),
    ]),
  );
  group.append(pop);

  // tap-away and Esc both cancel (revert); a stale listener (its pop replaced by
  // a re-render) unsubscribes itself, so only the live popover acts
  setTimeout(() => {
    const done = (): void => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    const onDown = (ev: MouseEvent): void => {
      if (!pop.isConnected) return done();
      if (!group.contains(ev.target as Node)) {
        done();
        spec.onCancel();
      }
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (!pop.isConnected) return done();
      if (ev.key === 'Escape') {
        done();
        spec.onCancel();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
  }, 0);

  return group;
}
