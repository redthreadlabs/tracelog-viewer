/**
 * Shared record-detail drawer: header with kind mark + actions, a meta
 * grid, and the raw record JSON with minimal syntax highlighting. Used by
 * the records log and the trace waterfall.
 */
import { el, clear } from './dom';
import type { Rec } from '../data/types';
import { parseRaw } from '../data/parse';
import { storeClient } from '../data/storeclient';
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
  // Lazy: the parsed tree exists only while the drawer is open. Retained
  // lines resolve in a microtask; shed lines re-read from the cache/bucket.
  const rawPromise: Promise<Record<string, unknown>> =
    rec.rawLine !== null
      ? Promise.resolve(parseRaw(rec))
      : storeClient.request('rawBody', {
          rec: { rawLine: rec.rawLine, sourceKey: rec.sourceKey, line: rec.line, kind: rec.kind },
        });
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
      on: {
        click: () =>
          void rawPromise.then((raw) =>
            navigator.clipboard.writeText(JSON.stringify(raw, null, 2)),
          ),
      },
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
  // client events carry the device's own UTC offset: show the local wall-clock
  // time where the event actually happened
  if (rec.tzOffset != null) {
    metaRow('client time', `${localWallClock(rec.ts, rec.tzOffset)} (UTC${fmtOffset(rec.tzOffset)})`);
  }
  // where this line came from: the source log file and its 1-based line number
  metaRow('file', rec.sourceKey);
  metaRow('line', String(rec.line + 1));
  metaRow('channel', rec.channel);
  metaRow('host', rec.host);
  metaRow('service', rec.meta.serviceVersion && `${rec.meta.serviceName} ${rec.meta.serviceVersion}`);
  metaRow('trace', rec.traceId);
  metaRow('user', rec.userId);

  const body = el('div', { className: 'drawer-body' }, [meta]);
  const loading = el('div', {
    className: 'faint',
    text: 'reading raw record…',
    attrs: { style: 'font-size:12px;padding:4px 0' },
  });
  body.append(loading);
  drawer.append(body);
  void rawPromise.then((raw) => {
    if (!loading.isConnected) return; // the drawer moved on to another record
    loading.remove();
    const errorBlock = renderErrorBlock(raw);
    if (errorBlock) body.append(errorBlock);
    body.append(prettyJson(raw));
  });
}

/** Wall-clock time at a given UTC offset (minutes east), as 'YYYY-MM-DD HH:MM:SS'. */
function localWallClock(tsMs: number, offsetMin: number): string {
  const d = new Date(tsMs + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Minutes east of UTC → '+HH:MM' / '-HH:MM'. */
function fmtOffset(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * Error inspector (SPEC §6.4): when the record carries error details —
 * `event.error` or an error record's `exception`/`log` — surface message,
 * type, code, and stack above the raw JSON.
 */
function renderErrorBlock(raw: Record<string, unknown>): HTMLElement | null {
  const source = (raw.error ?? raw.exception ?? raw.log) as
    | Record<string, unknown>
    | undefined;
  if (!source || typeof source !== 'object') return null;
  const message = typeof source.message === 'string' ? source.message : undefined;
  const type = typeof source.type === 'string' ? source.type : undefined;
  const code = typeof source.code === 'string' || typeof source.code === 'number'
    ? String(source.code)
    : undefined;
  const stack = typeof source.stack === 'string' ? source.stack : undefined;
  if (!message && !stack) return null;

  const block = el('div', { className: 'error-block' });
  block.append(
    el('div', { className: 'error-headline' }, [
      el('span', { className: 'lvl', text: type ?? 'error', attrs: { style: 'color: var(--level-error)' } }),
      code ? el('span', { className: 'chip', text: `code ${code}`, attrs: { style: 'cursor:default' } }) : '',
      el('span', { className: 'error-message', text: message ?? '' }),
    ]),
  );
  if (stack) {
    block.append(el('pre', { className: 'json error-stack', text: stack }));
  }
  return block;
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
