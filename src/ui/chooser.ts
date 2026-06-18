/**
 * A pill-dropdown chooser: a compact pill showing a selection summary that
 * opens an option list. Two modes share one component:
 *
 *  - multi  (channels / hosts): checkboxes + All / None + an OK / Cancel
 *    footer. Editing is local and DEFERRED — only OK commits; Cancel, tap-away,
 *    and Esc revert. The caller owns the pending `selected` set.
 *  - single (bars): radios, no All / None, no footer. Selecting an option
 *    applies immediately and dismisses (the caller's onChange does both).
 *    Tap-away / Esc just close.
 *
 * Stateless: the caller owns the open flag and the selected set and re-renders
 * on every change; the popover self-prunes stale listeners.
 */
import { el } from './dom';

export interface ChooserSpec {
  /** field name shown beside the pill, e.g. "Channels" */
  label: string;
  /** every available value (already sorted) */
  values: string[];
  /** the (pending, in multi mode) selected subset; one element in single mode */
  selected: Set<string>;
  /** whether the dropdown is open (caller-owned, survives re-renders) */
  open: boolean;
  /** 'multi' (default): checkboxes + All/None + OK/Cancel. 'single': radios,
   *  apply-on-select, no footer. */
  mode?: 'multi' | 'single';
  /** display label for a value (defaults to the value itself) — lets the bars
   *  picker show "1 hour" for the token "1h" */
  labelOf?: (value: string) => string;
  /** an optional leading mode-row (multi mode only), mutually exclusive with the
   *  checkboxes — e.g. the hosts picker's "all current". When active it overrides
   *  the summary and dims the list (the manual selection is set aside). */
  special?: { label: string; active: boolean; title?: string; onToggle: () => void };
  /** the pill was clicked while closed → open (+ snapshot, in multi mode) */
  onOpen: () => void;
  /** an option changed. multi: pending only (not applied). single: apply + close. */
  onChange: (selected: Set<string>) => void;
  /** OK → apply the pending selection (multi mode only) */
  onCommit?: () => void;
  /** Cancel / tap-away / Esc → multi: revert; single: just close */
  onCancel: () => void;
}

function summary(spec: ChooserSpec): string {
  const label = spec.labelOf ?? ((v) => v);
  if (spec.mode === 'single') {
    const v = [...spec.selected][0];
    return v !== undefined ? label(v) : '—';
  }
  if (spec.special?.active) return spec.special.label;
  if (spec.values.length === 0) return 'none available';
  const on = spec.values.filter((v) => spec.selected.has(v));
  if (on.length === 0) return 'none';
  if (on.length === spec.values.length) return 'all';
  if (on.length === 1) return label(on[0]);
  return `${on.length} of ${spec.values.length}`;
}

export function renderChooser(spec: ChooserSpec): HTMLElement {
  const single = spec.mode === 'single';
  const label = spec.labelOf ?? ((v) => v);

  const group = el('div', { className: 'group chooser-wrap' }, [
    el('span', { className: 'label', text: spec.label }),
  ]);

  const pill = el(
    'button',
    { className: spec.open ? 'chip chooser-pill on' : 'chip chooser-pill' },
    [el('span', { text: summary(spec) }), el('span', { className: 'caret', text: '▾' })],
  );
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    // clicking the pill while open closes WITHOUT applying (multi: only OK commits)
    if (spec.open) spec.onCancel();
    else spec.onOpen();
  });
  group.append(pill);

  if (!spec.open) return group;

  const pop = el('div', { className: 'chooser-pop' });

  // an optional leading mode-row (e.g. hosts' "all current"): a distinct toggle
  // above the list, mutually exclusive with the checkboxes
  if (!single && spec.special) {
    const sp = spec.special;
    const input = el('input', { attrs: { type: 'checkbox' } });
    (input as HTMLInputElement).checked = sp.active;
    const row = el('label', { className: 'chooser-row chooser-special' }, [
      input,
      el('span', { text: sp.label }),
    ]);
    if (sp.title) row.title = sp.title;
    row.addEventListener('click', (e) => {
      e.preventDefault();
      sp.onToggle();
    });
    pop.append(row);
  }

  // bulk actions only make sense for multi-select
  if (!single) {
    pop.append(
      el('div', { className: 'chooser-actions' }, [
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
  }

  // only the option list scrolls — All/None and OK/Cancel stay anchored. When
  // the special mode is active the manual list is set aside (dimmed); clicking a
  // value still works and the caller switches back to manual.
  const list = el('div', {
    className: spec.special?.active ? 'chooser-list dimmed' : 'chooser-list',
  });
  if (spec.values.length === 0) {
    list.append(el('div', { className: 'faint chooser-empty', text: 'none in range' }));
  }
  for (const v of spec.values) {
    const input = el('input', { attrs: { type: single ? 'radio' : 'checkbox' } });
    (input as HTMLInputElement).checked = spec.selected.has(v);
    const row = el('label', { className: 'chooser-row' }, [input, el('span', { text: label(v) })]);
    row.addEventListener('click', (e) => {
      e.preventDefault(); // we drive the checked state from `selected`
      if (single) {
        spec.onChange(new Set([v])); // caller applies + dismisses
      } else {
        const next = new Set(spec.selected);
        if (next.has(v)) next.delete(v);
        else next.add(v);
        spec.onChange(next);
      }
    });
    list.append(row);
  }
  pop.append(list);

  // single mode applies on select, so it needs no footer
  if (!single) {
    pop.append(
      el('div', { className: 'chooser-footer' }, [
        el('button', { className: 'btn btn-quiet', text: 'Cancel', on: { click: () => spec.onCancel() } }),
        el('button', { className: 'btn btn-primary', text: 'OK', on: { click: () => spec.onCommit?.() } }),
      ]),
    );
  }
  group.append(pop);

  // tap-away and Esc both close (multi: revert; single: just close); a stale
  // listener (its pop replaced by a re-render) unsubscribes itself
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
