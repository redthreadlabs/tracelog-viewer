/**
 * Raw record table with filters (SPEC M1): kind and level chips with live
 * counts, channel and host filters, free-text search, time ordering, and a
 * detail drawer showing the raw record JSON. Rows are windowed so a month
 * of records scrolls smoothly.
 */
import { el, clear } from '../dom';
import { store } from '../../data/store';
import { RECORD_KINDS, type Rec, type RecordKind } from '../../data/types';
import { fmtBytes, fmtCount, fmtDateTime, fmtDuration, zoneLabel } from '../format';

const ROW_HEIGHT = 27;
const OVERSCAN = 12;
const LEVELS = ['debug', 'info', 'warn', 'error'];

interface Filters {
  kinds: Set<RecordKind>;
  levels: Set<string>;
  channel: string | null;
  host: string | null;
  search: string;
  newestFirst: boolean;
}

export function renderRecordsView(container: HTMLElement): () => void {
  const filters: Filters = {
    kinds: new Set(RECORD_KINDS),
    levels: new Set(LEVELS),
    channel: null,
    host: null,
    search: '',
    newestFirst: true,
  };

  let filtered: Rec[] = [];
  let selected: Rec | null = null;
  let lastGeneration = -1;

  // --- static skeleton ---
  const filterbar = el('div', { className: 'filterbar' });
  const wrap = el('div', { className: 'records-wrap' });
  const drawer = el('div', { className: 'drawer' });
  container.append(filterbar, wrap, drawer);

  const table = el('table', { className: 'records' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);

  const topSpacer = el('div');
  const bottomSpacer = el('div');
  wrap.append(topSpacer, table, bottomSpacer);

  wrap.addEventListener('scroll', renderRows);

  function applyFilters(): void {
    const q = filters.search.toLowerCase();
    filtered = store.records.filter((r) => {
      if (!filters.kinds.has(r.kind)) return false;
      if (r.kind === 'event' && r.level && !filters.levels.has(r.level)) return false;
      if (filters.channel && r.channel !== filters.channel) return false;
      if (filters.host && r.host !== filters.host) return false;
      if (q) {
        const hay =
          `${r.name} ${r.message ?? ''} ${r.userId ?? ''} ${r.traceId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) {
          // fall back to raw JSON only when the cheap fields miss
          if (!JSON.stringify(r.raw).toLowerCase().includes(q)) return false;
        }
      }
      return true;
    });
    if (filters.newestFirst) filtered.reverse();
  }

  function renderFilterbar(): void {
    clear(filterbar);

    // kind chips with counts
    for (const kind of RECORD_KINDS) {
      const count = store.kindCounts.get(kind) ?? 0;
      const on = filters.kinds.has(kind);
      const chip = el('button', { className: on ? 'chip on' : 'chip' }, [
        el('span', {
          className: 'dot',
          attrs: { style: `background: var(--kind-${kind})` },
        }),
        el('span', { text: kind }),
        el('span', { className: 'count', text: fmtCount(count) }),
      ]);
      chip.addEventListener('click', () => {
        if (on) filters.kinds.delete(kind);
        else filters.kinds.add(kind);
        refresh(true);
      });
      filterbar.append(chip);
    }

    filterbar.append(el('span', { attrs: { style: 'width:10px' } }));

    // level chips (apply to events)
    for (const level of LEVELS) {
      const on = filters.levels.has(level);
      const chip = el('button', { className: on ? 'chip on' : 'chip' }, [
        el('span', { className: 'dot', attrs: { style: `background: var(--level-${level})` } }),
        el('span', { text: level }),
      ]);
      chip.addEventListener('click', () => {
        if (on) filters.levels.delete(level);
        else filters.levels.add(level);
        refresh(true);
      });
      filterbar.append(chip);
    }

    // channel / host selects
    if (store.channelCounts.size > 1) {
      filterbar.append(
        selectFilter('all channels', [...store.channelCounts.keys()], filters.channel, (v) => {
          filters.channel = v;
          refresh(true);
        }),
      );
    }
    if (store.hosts.size > 1) {
      filterbar.append(
        selectFilter('all hosts', [...store.hosts].sort(), filters.host, (v) => {
          filters.host = v;
          refresh(true);
        }),
      );
    }

    filterbar.append(el('span', { className: 'spacer' }));

    // result count
    filterbar.append(
      el('span', {
        className: 'budget',
        text: `${fmtCount(filtered.length)} of ${fmtCount(store.records.length)} records`,
      }),
    );

    // order toggle
    filterbar.append(
      el('button', {
        className: 'toggle on',
        text: filters.newestFirst ? 'newest first' : 'oldest first',
        on: {
          click: () => {
            filters.newestFirst = !filters.newestFirst;
            refresh(true);
          },
        },
      }),
    );

    // search
    const search = el('input', {
      className: 'input search',
      attrs: { type: 'search', placeholder: 'Search name, message, user, trace…' },
    });
    search.value = filters.search;
    let debounce: ReturnType<typeof setTimeout>;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        filters.search = search.value.trim();
        refresh(true);
      }, 150);
    });
    filterbar.append(search);
  }

  function renderHead(): void {
    clear(thead);
    thead.append(
      el('tr', {}, [
        th(`time (${zoneLabel()})`, 'width:190px'),
        th('kind', 'width:110px'),
        th('channel', 'width:110px'),
        th('name', ''),
        th('detail', 'width:30%'),
        th('duration', 'width:90px;text-align:right'),
        th('user', 'width:140px'),
      ]),
    );
  }

  function renderRows(): void {
    const viewTop = wrap.scrollTop;
    const viewHeight = wrap.clientHeight;
    const first = Math.max(0, Math.floor(viewTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(
      filtered.length,
      Math.ceil((viewTop + viewHeight) / ROW_HEIGHT) + OVERSCAN,
    );

    topSpacer.style.height = `${first * ROW_HEIGHT}px`;
    bottomSpacer.style.height = `${Math.max(0, (filtered.length - last) * ROW_HEIGHT)}px`;

    clear(tbody);
    for (let i = first; i < last; i++) {
      tbody.append(row(filtered[i]));
    }
  }

  function row(r: Rec): HTMLTableRowElement {
    const tr = el('tr', { className: selected?.id === r.id ? 'selected' : '' });
    tr.style.height = `${ROW_HEIGHT}px`;

    const detail =
      r.kind === 'event' || r.kind === 'error'
        ? (r.message ?? '')
        : r.kind === 'span'
          ? (r.result ?? '')
          : (r.result ?? '');

    tr.append(
      el('td', { className: 'num', text: fmtDateTime(r.ts) }),
      el('td', {}, [
        el('span', { className: 'kind-mark', attrs: { style: `background: var(--kind-${r.kind})` } }),
        r.kind === 'event' && r.level
          ? el('span', {
              className: 'lvl',
              text: r.level,
              attrs: { style: `color: var(--level-${r.level})` },
            })
          : el('span', { className: 'lvl muted', text: r.kind.slice(0, 4) }),
      ]),
      el('td', { className: 'muted', text: r.channel }),
      el('td', { className: 'grow', text: r.name, title: r.name }),
      el('td', { className: 'muted grow', text: detail, title: detail }),
      el('td', {
        className: 'num',
        text: r.duration !== undefined ? fmtDuration(r.duration) : '',
        attrs: { style: 'text-align:right' },
      }),
      el('td', { className: 'mono faint', text: r.userId ?? '' }),
    );

    tr.addEventListener('click', () => {
      selected = r;
      renderDrawer();
      renderRows();
    });
    return tr;
  }

  function renderDrawer(): void {
    clear(drawer);
    if (!selected) {
      drawer.classList.remove('open');
      return;
    }
    const r = selected;
    drawer.classList.add('open');

    drawer.append(
      el('div', { className: 'drawer-head' }, [
        el('span', { className: 'kind-mark', attrs: { style: `background: var(--kind-${r.kind})` } }),
        el('h3', { text: r.name }),
        el('button', {
          className: 'btn btn-quiet',
          text: 'copy',
          on: {
            click: () => void navigator.clipboard.writeText(JSON.stringify(r.raw, null, 2)),
          },
        }),
        el('button', {
          className: 'btn btn-quiet',
          text: '✕',
          on: {
            click: () => {
              selected = null;
              renderDrawer();
              renderRows();
            },
          },
        }),
      ]),
    );

    const meta = el('div', { className: 'drawer-meta' });
    const metaRow = (label: string, value?: string) => {
      if (!value) return;
      meta.append(
        el('span', { className: 'label', text: label }),
        el('span', { className: 'mono', text: value }),
      );
    };
    metaRow('kind', r.kind);
    metaRow('time', `${fmtDateTime(r.ts)} ${zoneLabel()}`);
    metaRow('channel', r.channel);
    metaRow('host', r.host);
    metaRow('service', r.meta.serviceVersion && `${r.meta.serviceName} ${r.meta.serviceVersion}`);
    metaRow('trace', r.traceId);
    metaRow('user', r.userId);

    drawer.append(
      el('div', { className: 'drawer-body' }, [meta, prettyJson(r.raw)]),
    );
  }

  function renderEmpty(): void {
    clear(filterbar);
    clear(tbody);
    clear(thead);
    const { running, filesTotal, filesDone, bytesDone, error } = store.progress;
    const empty = el('div', { className: 'empty' }, [
      el('div', { className: 'fleuron', text: '❧' }),
      running
        ? el('h3', { text: `Scanning… ${filesDone} of ${filesTotal} files` })
        : error
          ? el('h3', { text: 'The scan hit a snag' })
          : el('h3', { text: 'Nothing scanned yet' }),
      el('p', {
        text: running
          ? `${fmtBytes(bytesDone)} fetched — records appear as files land.`
          : error
            ? error
            : 'Choose channels and a date range above. The download budget is shown before any byte is fetched.',
      }),
    ]);
    wrap.append(empty);
  }

  function refresh(filtersChanged = false): void {
    if (store.generation !== lastGeneration || filtersChanged) {
      lastGeneration = store.generation;
      applyFilters();
    }
    const existingEmpty = wrap.querySelector('.empty');
    if (existingEmpty) existingEmpty.remove();
    if (store.records.length === 0) {
      renderEmpty();
      return;
    }
    renderFilterbar();
    renderHead();
    renderRows();
  }

  const onData = () => refresh();
  const onProgress = () => {
    if (store.records.length === 0) refresh();
  };
  store.addEventListener('data', onData);
  store.addEventListener('progress', onProgress);
  refresh();

  // teardown for the router
  return () => {
    store.removeEventListener('data', onData);
    store.removeEventListener('progress', onProgress);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}

function selectFilter(
  allLabel: string,
  options: string[],
  value: string | null,
  onChange: (v: string | null) => void,
): HTMLSelectElement {
  const select = el('select', { className: 'select' });
  select.append(el('option', { text: allLabel, attrs: { value: '' } }));
  for (const opt of options) {
    const option = el('option', { text: opt, attrs: { value: opt } });
    select.append(option);
  }
  select.value = value ?? '';
  select.addEventListener('change', () => onChange(select.value || null));
  return select;
}

/** Minimal JSON syntax highlighting — keys, strings, numbers, booleans. */
function prettyJson(obj: unknown): HTMLElement {
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
