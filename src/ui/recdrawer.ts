/**
 * Shared record-detail drawer: header with kind mark + actions, a meta
 * grid, and the raw record JSON with minimal syntax highlighting. Used by
 * the records log and the trace waterfall.
 */
import { el, clear } from './dom';
import type { Rec } from '../data/types';
import { fmtDateTime, zoneLabel } from './format';

export interface DrawerAction {
  label: string;
  title?: string;
  onClick: () => void;
}

export function renderRecDrawer(
  drawer: HTMLElement,
  rec: Rec | null,
  onClose: () => void,
  actions: DrawerAction[] = [],
): void {
  clear(drawer);
  if (!rec) {
    drawer.classList.remove('open');
    return;
  }
  drawer.classList.add('open');

  const head = el('div', { className: 'drawer-head' }, [
    el('span', { className: 'kind-mark', attrs: { style: `background: var(--kind-${rec.kind})` } }),
    el('h3', { text: rec.name }),
  ]);
  for (const action of actions) {
    head.append(
      el('button', {
        className: 'btn btn-quiet',
        text: action.label,
        title: action.title,
        on: { click: action.onClick },
      }),
    );
  }
  head.append(
    el('button', {
      className: 'btn btn-quiet',
      text: 'copy',
      on: { click: () => void navigator.clipboard.writeText(JSON.stringify(rec.raw, null, 2)) },
    }),
    el('button', { className: 'btn btn-quiet', text: '✕', on: { click: onClose } }),
  );
  drawer.append(head);

  const meta = el('div', { className: 'drawer-meta' });
  const metaRow = (label: string, value?: string) => {
    if (!value) return;
    meta.append(
      el('span', { className: 'label', text: label }),
      el('span', { className: 'mono', text: value }),
    );
  };
  metaRow('kind', rec.kind);
  metaRow('time', `${fmtDateTime(rec.ts)} ${zoneLabel()}`);
  metaRow('channel', rec.channel);
  metaRow('host', rec.host);
  metaRow('service', rec.meta.serviceVersion && `${rec.meta.serviceName} ${rec.meta.serviceVersion}`);
  metaRow('trace', rec.traceId);
  metaRow('user', rec.userId);

  drawer.append(el('div', { className: 'drawer-body' }, [meta, prettyJson(rec.raw)]));
}

/** Minimal JSON syntax highlighting — keys, strings, numbers, booleans. */
export function prettyJson(obj: unknown): HTMLElement {
  const json = JSON.stringify(obj, null, 2);
  const pre = el('pre', { className: 'json' });
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  pre.innerHTML = escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str, colon, bool) => {
      if (str !== undefined) {
        return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      }
      if (bool !== undefined) return `<span class="b">${bool}</span>`;
      return `<span class="n">${match}</span>`;
    },
  );
  return pre;
}
