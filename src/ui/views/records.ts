/**
 * Raw record log (secondary view): kind and level chips with live counts,
 * channel and host filters, free-text search, newest/oldest ordering, and a
 * detail drawer with the raw record JSON. Paginated.
 */
import { el, clear } from '../dom';
import { store, windowSlice } from '../../data/store';
import { RECORD_KINDS, type Rec, type RecordKind } from '../../data/types';
import { viewState } from '../../state';
import { renderRecDrawer } from '../recdrawer';
import { getParam, setParams, setView } from '../hashstate';
import { fmtBytes, fmtCount, fmtDateTime, fmtDuration, zoneLabel } from '../format';

const PAGE_SIZE = 100;
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
    search: viewState.pendingRecordsSearch ?? getParam('q') ?? '',
    newestFirst: true,
  };
  viewState.pendingRecordsSearch = null;

  let filtered: Rec[] = [];
  let page = 0;
  let selected: Rec | null = null;
  let lastGeneration = -1;

  const filterbar = el('div', { className: 'filterbar' });
  const wrap = el('div', { className: 'records-wrap' });
  const pagerbar = el('div', { className: 'pagerbar' });
  const drawer = el('div', { className: 'drawer' });
  container.append(filterbar, wrap, pagerbar, drawer);

  const table = el('table', { className: 'records' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.append(table);

  function applyFilters(): void {
    const q = filters.search.toLowerCase();
    const w = viewState.timeWindow;
    // binary-searched run of the sorted store; the predicate below no
    // longer needs a per-record time check
    filtered = windowSlice(store.records, w).filter((r) => {
      if (!filters.kinds.has(r.kind)) return false;
      if (r.kind === 'event' && r.level && !filters.levels.has(r.level)) return false;
      if (filters.channel && r.channel !== filters.channel) return false;
      if (filters.host && r.host !== filters.host) return false;
      if (q) {
        const hay =
          `${r.name} ${r.message ?? ''} ${r.userId ?? ''} ${r.traceId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) {
          if (r.rawLine === null || !r.rawLine.toLowerCase().includes(q)) return false;
        }
      }
      return true;
    });
    if (filters.newestFirst) filtered.reverse();
    page = Math.min(page, maxPage());
  }

  function maxPage(): number {
    return Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  }

  function renderFilterbar(): void {
    clear(filterbar);

    for (const kind of RECORD_KINDS) {
      const count = store.kindCounts.get(kind) ?? 0;
      const on = filters.kinds.has(kind);
      const chip = el('button', { className: on ? 'chip on' : 'chip' }, [
        el('span', { className: 'dot', attrs: { style: `background: var(--kind-${kind})` } }),
        el('span', { text: kind }),
        el('span', { className: 'count', text: fmtCount(count) }),
      ]);
      chip.addEventListener('click', () => {
        if (on) filters.kinds.delete(kind);
        else filters.kinds.add(kind);
        page = 0;
        refresh(true);
      });
      filterbar.append(chip);
    }

    filterbar.append(el('span', { attrs: { style: 'width:10px' } }));

    for (const level of LEVELS) {
      const on = filters.levels.has(level);
      const chip = el('button', { className: on ? 'chip on' : 'chip' }, [
        el('span', { className: 'dot', attrs: { style: `background: var(--level-${level})` } }),
        el('span', { text: level }),
      ]);
      chip.addEventListener('click', () => {
        if (on) filters.levels.delete(level);
        else filters.levels.add(level);
        page = 0;
        refresh(true);
      });
      filterbar.append(chip);
    }

    if (store.channelCounts.size > 1) {
      filterbar.append(
        selectFilter('all channels', [...store.channelCounts.keys()], filters.channel, (v) => {
          filters.channel = v;
          page = 0;
          refresh(true);
        }),
      );
    }
    if (store.hosts.size > 1) {
      filterbar.append(
        selectFilter('all hosts', [...store.hosts].sort(), filters.host, (v) => {
          filters.host = v;
          page = 0;
          refresh(true);
        }),
      );
    }

    filterbar.append(el('span', { className: 'spacer' }));

    if (viewState.timeWindow) {
      filterbar.append(
        el('button', {
          className: 'chip on',
          text: '⧖ brushed window ✕',
          title: 'records are narrowed to the time window brushed on the overview — click to clear',
          on: {
            click: () => {
              viewState.timeWindow = null;
              page = 0;
              refresh(true);
            },
          },
        }),
      );
    }

    filterbar.append(
      el('button', {
        className: 'toggle on',
        text: filters.newestFirst ? 'newest first' : 'oldest first',
        on: {
          click: () => {
            filters.newestFirst = !filters.newestFirst;
            page = 0;
            refresh(true);
          },
        },
      }),
    );

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
        setParams({ q: filters.search || null });
        page = 0;
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
    clear(tbody);
    const start = page * PAGE_SIZE;
    for (const r of filtered.slice(start, start + PAGE_SIZE)) {
      tbody.append(row(r));
    }
    wrap.scrollTop = 0;
  }

  function renderPager(): void {
    clear(pagerbar);
    const pages = maxPage() + 1;
    pagerbar.append(
      el('span', {
        className: 'budget',
        text: `${fmtCount(filtered.length)} of ${fmtCount(store.records.length)} records`,
      }),
      el('span', { className: 'masthead-spacer' }),
      el('button', {
        className: 'btn btn-quiet',
        text: '⇤',
        title: 'first page',
        on: { click: () => goto(0) },
      }),
      el('button', {
        className: 'btn btn-quiet',
        text: '‹ prev',
        on: { click: () => goto(page - 1) },
      }),
      el('span', {
        className: 'budget',
        text: pages > 0 ? `page ${fmtCount(page + 1)} of ${fmtCount(pages)}` : '—',
      }),
      el('button', {
        className: 'btn btn-quiet',
        text: 'next ›',
        on: { click: () => goto(page + 1) },
      }),
      el('button', {
        className: 'btn btn-quiet',
        text: '⇥',
        title: 'last page',
        on: { click: () => goto(maxPage()) },
      }),
    );

    const prevBtns = pagerbar.querySelectorAll('button');
    if (page === 0) {
      (prevBtns[0] as HTMLButtonElement).disabled = true;
      (prevBtns[1] as HTMLButtonElement).disabled = true;
    }
    if (page >= maxPage()) {
      (prevBtns[2] as HTMLButtonElement).disabled = true;
      (prevBtns[3] as HTMLButtonElement).disabled = true;
    }
  }

  function goto(p: number): void {
    page = Math.max(0, Math.min(p, maxPage()));
    renderRows();
    renderPager();
  }

  function row(r: Rec): HTMLTableRowElement {
    const tr = el('tr', { className: selected?.id === r.id ? 'selected' : '' });

    const detail =
      r.kind === 'event' || r.kind === 'error' ? (r.message ?? '') : (r.result ?? '');

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
    renderRecDrawer(
      drawer,
      selected,
      () => {
        selected = null;
        renderDrawer();
        renderRows();
      },
      [
        ...(selected?.userId
          ? [
              {
                label: '±5 min context',
                title: "show this user's surrounding events",
                onClick: () => {
                  viewState.userContext = { userId: selected!.userId!, ts: selected!.ts };
                  setView('/events');
                },
              },
            ]
          : []),
        ...(selected?.traceId
          ? [
              {
                label: 'view trace →',
                title: 'open the waterfall for this trace',
                onClick: () => {
                  setView(`/trace/${selected!.traceId}`);
                },
              },
            ]
          : []),
      ],
    );
  }

  function renderEmpty(): void {
    clear(filterbar);
    clear(tbody);
    clear(thead);
    clear(pagerbar);
    const { running, bytesDone, error } = store.progress;
    wrap.append(
      el('div', { className: 'empty' }, [
        el('div', { className: 'fleuron', text: '❧' }),
        running
          ? el('h3', { text: `Loading… ${fmtBytes(bytesDone)}` })
          : error
            ? el('h3', { text: 'The scan hit a snag' })
            : el('h3', { text: 'Nothing scanned yet' }),
        el('p', {
          text: running
            ? 'Records appear as data arrives.'
            : error
              ? error
              : 'Pick a range above — it loads on its own; a large range will ask first.',
        }),
      ]),
    );
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
    renderPager();
  }

  const onData = () => refresh();
  const onProgress = () => {
    if (store.records.length === 0) refresh();
  };
  store.addEventListener('data', onData);
  store.addEventListener('progress', onProgress);
  refresh();

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
    select.append(el('option', { text: opt, attrs: { value: opt } }));
  }
  select.value = value ?? '';
  select.addEventListener('change', () => onChange(select.value || null));
  return select;
}
