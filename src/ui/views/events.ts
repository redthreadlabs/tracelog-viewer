/**
 * Events & errors view (SPEC §6.4): a table specialized for the event
 * stream — level and type facets, user filter, free-text search over
 * message + params, paginated — with the error inspector in the drawer and
 * the primary field-debugging move: "show this user's surrounding events
 * ±5 minutes", arriving via viewState.userContext from any view.
 */
import { el, clear } from '../dom';
import { store, mergeByTime, windowSlice } from '../../data/store';
import type { Rec } from '../../data/types';
import { viewState } from '../../state';
import { renderRecDrawer, type DrawerAction } from '../recdrawer';
import { getParam, setParams, setView } from '../hashstate';
import { fmtCount, fmtDateTime, fmtTime, zoneLabel } from '../format';

const PAGE_SIZE = 100;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const TYPE_FACET_LIMIT = 14;
const CONTEXT_HALF_WINDOW_MS = 5 * 60_000;

interface Filters {
  levels: Set<string>;
  type: string | null;
  channel: string | null;
  user: string;
  search: string;
  newestFirst: boolean;
  /** the ±5 min user-context window, independent of the global brush */
  contextWindow: [number, number] | null;
}

export function renderEventsView(container: HTMLElement): () => void {
  const filters: Filters = {
    levels: new Set(LEVELS),
    type: getParam('type'),
    channel: null,
    user: getParam('user') ?? '',
    search: getParam('q') ?? '',
    newestFirst: true,
    contextWindow: null,
  };

  if (viewState.pendingEventsUser !== null) {
    filters.user = viewState.pendingEventsUser;
    viewState.pendingEventsUser = null;
    setParams({ user: filters.user || null });
  }

  // arriving via "± 5 min context" from another view
  if (viewState.userContext) {
    const { userId, ts } = viewState.userContext;
    filters.user = userId;
    filters.contextWindow = [ts - CONTEXT_HALF_WINDOW_MS, ts + CONTEXT_HALF_WINDOW_MS];
    filters.newestFirst = false; // read the story forward
    viewState.userContext = null;
  }

  let filtered: Rec[] = [];
  let page = 0;
  let selected: Rec | null = null;
  let lastGeneration = -1;

  const filterbar = el('div', { className: 'filterbar' });
  const facetbar = el('div', { className: 'filterbar', attrs: { style: 'border-top:0;padding-top:0' } });
  const wrap = el('div', { className: 'records-wrap' });
  const pagerbar = el('div', { className: 'pagerbar' });
  const drawer = el('div', { className: 'drawer' });
  container.append(filterbar, facetbar, wrap, pagerbar, drawer);

  const table = el('table', { className: 'records' });
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.append(table);

  function pool(): Rec[] {
    return mergeByTime(store.kindRecords('event'), store.kindRecords('error'));
  }

  function applyFilters(): void {
    const q = filters.search.toLowerCase();
    const user = filters.user.trim();
    const w = filters.contextWindow ?? viewState.timeWindow;
    filtered = windowSlice(pool(), w).filter((r) => {
      if (r.level && !filters.levels.has(r.level)) return false;
      if (filters.type && r.name !== filters.type) return false;
      if (filters.channel && r.channel !== filters.channel) return false;
      if (user && r.userId !== user) return false;
      if (q) {
        const hay = `${r.name} ${r.message ?? ''} ${r.userId ?? ''}`.toLowerCase();
        if (!hay.includes(q) && (r.rawLine === null || !r.rawLine.toLowerCase().includes(q))) {
          return false;
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

    for (const level of LEVELS) {
      const on = filters.levels.has(level);
      const count = pool().filter((r) => r.level === level).length;
      const chip = el('button', { className: on ? 'chip on' : 'chip' }, [
        el('span', { className: 'dot', attrs: { style: `background: var(--level-${level})` } }),
        el('span', { text: level }),
        el('span', { className: 'count', text: fmtCount(count) }),
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
      const select = el('select', { className: 'select' });
      select.append(el('option', { text: 'all channels', attrs: { value: '' } }));
      for (const ch of store.channelCounts.keys()) {
        select.append(el('option', { text: ch, attrs: { value: ch } }));
      }
      select.value = filters.channel ?? '';
      select.addEventListener('change', () => {
        filters.channel = select.value || null;
        page = 0;
        refresh(true);
      });
      filterbar.append(select);
    }

    const userInput = el('input', {
      className: 'input mono',
      attrs: { type: 'search', placeholder: 'user id…', style: 'width:170px;font-size:12px' },
    });
    userInput.value = filters.user;
    userInput.addEventListener('change', () => {
      filters.user = userInput.value.trim();
      setParams({ user: filters.user || null });
      page = 0;
      refresh(true);
    });
    filterbar.append(userInput);

    if (filters.contextWindow) {
      filterbar.append(
        el('button', {
          className: 'chip on',
          text: `⧖ ${fmtTime(filters.contextWindow[0])} – ${fmtTime(filters.contextWindow[1])} ✕`,
          title: '±5 min context window — click to clear',
          on: {
            click: () => {
              filters.contextWindow = null;
              page = 0;
              refresh(true);
            },
          },
        }),
      );
    } else if (viewState.timeWindow) {
      filterbar.append(
        el('button', {
          className: 'chip on',
          text: '⧖ brushed window ✕',
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

    filterbar.append(el('span', { className: 'spacer' }));

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
      attrs: { type: 'search', placeholder: 'Search message, params…' },
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

  function renderFacets(): void {
    clear(facetbar);
    const counts = new Map<string, number>();
    for (const r of pool()) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TYPE_FACET_LIMIT);

    facetbar.append(el('span', { className: 'label', text: 'Type' }));
    for (const [type, count] of top) {
      const on = filters.type === type;
      facetbar.append(
        el('button', { className: on ? 'chip on' : 'chip' }, [
          el('span', { text: type }),
          el('span', { className: 'count', text: fmtCount(count) }),
        ]),
      );
      facetbar.lastElementChild!.addEventListener('click', () => {
        filters.type = on ? null : type;
        setParams({ type: filters.type });
        page = 0;
        refresh(true);
      });
    }
    if (filters.type && !top.some(([t]) => t === filters.type)) {
      facetbar.append(
        el('button', {
          className: 'chip on',
          text: `${filters.type} ✕`,
          on: {
            click: () => {
              filters.type = null;
              setParams({ type: null });
              page = 0;
              refresh(true);
            },
          },
        }),
      );
    }
  }

  function renderHead(): void {
    clear(thead);
    thead.append(
      el('tr', {}, [
        th(`time (${zoneLabel()})`, 'width:190px'),
        th('level', 'width:70px'),
        th('type', 'width:220px'),
        th('message', ''),
        th('user', 'width:150px'),
        th('device', 'width:170px'),
        th('channel', 'width:90px'),
      ]),
    );
  }

  function deviceOf(rec: Rec): string {
    return [rec.device, rec.os].filter(Boolean).join(' · ');
  }

  function renderRows(): void {
    clear(tbody);
    const start = page * PAGE_SIZE;
    for (const r of filtered.slice(start, start + PAGE_SIZE)) {
      const tr = el('tr', { className: selected?.id === r.id ? 'selected' : '' });
      tr.append(
        el('td', { className: 'num', text: fmtDateTime(r.ts) }),
        el('td', {}, [
          el('span', {
            className: 'lvl',
            text: r.level ?? '',
            attrs: { style: `color: var(--level-${r.level ?? 'info'})` },
          }),
        ]),
        el('td', { className: 'grow', text: r.name, title: r.name, attrs: { style: 'max-width:220px' } }),
        el('td', { className: 'muted grow', text: r.message ?? '', title: r.message }),
        el('td', { className: 'mono faint', text: r.userId ?? '' }),
        el('td', { className: 'muted', text: deviceOf(r) }),
        el('td', { className: 'faint', text: r.channel }),
      );
      tr.addEventListener('click', () => {
        selected = r;
        renderDrawer();
        renderRows();
      });
      tbody.append(tr);
    }
    wrap.scrollTop = 0;
  }

  function renderDrawer(): void {
    const actions: DrawerAction[] = [];
    if (selected?.userId) {
      const rec = selected;
      actions.push({
        label: '±5 min context',
        title: "show this user's surrounding events",
        onClick: () => {
          filters.user = rec.userId!;
          filters.type = null;
          filters.search = '';
          filters.levels = new Set(LEVELS);
          filters.contextWindow = [
            rec.ts - CONTEXT_HALF_WINDOW_MS,
            rec.ts + CONTEXT_HALF_WINDOW_MS,
          ];
          filters.newestFirst = false;
          page = 0;
          refresh(true);
        },
      });
    }
    if (selected?.traceId) {
      const rec = selected;
      actions.push({
        label: 'view trace →',
        onClick: () => {
          setView(`/trace/${rec.traceId}`);
        },
      });
    }
    renderRecDrawer(
      drawer,
      selected,
      () => {
        selected = null;
        renderDrawer();
        renderRows();
      },
      actions,
    );
  }

  function renderPager(): void {
    clear(pagerbar);
    const pages = maxPage() + 1;
    pagerbar.append(
      el('span', {
        className: 'budget',
        text: `${fmtCount(filtered.length)} of ${fmtCount(pool().length)} events & errors`,
      }),
      el('span', { className: 'masthead-spacer' }),
      pagerBtn('⇤', () => goto(0), page === 0),
      pagerBtn('‹ prev', () => goto(page - 1), page === 0),
      el('span', {
        className: 'budget',
        text: pages > 0 ? `page ${fmtCount(page + 1)} of ${fmtCount(pages)}` : '—',
      }),
      pagerBtn('next ›', () => goto(page + 1), page >= maxPage()),
      pagerBtn('⇥', () => goto(maxPage()), page >= maxPage()),
    );
  }

  function pagerBtn(text: string, onClick: () => void, disabled: boolean): HTMLButtonElement {
    const btn = el('button', { className: 'btn btn-quiet', text, on: { click: onClick } });
    btn.disabled = disabled;
    return btn;
  }

  function goto(p: number): void {
    page = Math.max(0, Math.min(p, maxPage()));
    renderRows();
    renderPager();
  }

  function renderEmpty(): void {
    clear(filterbar);
    clear(facetbar);
    clear(thead);
    clear(tbody);
    clear(pagerbar);
    wrap.append(
      el('div', { className: 'empty' }, [
        el('div', { className: 'fleuron', text: '❧' }),
        el('h3', { text: 'No events scanned yet' }),
        el('p', { text: 'Scan a range above; events and errors land here.' }),
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
    if (pool().length === 0) {
      renderEmpty();
      return;
    }
    renderFilterbar();
    renderFacets();
    renderHead();
    renderRows();
    renderPager();
  }

  const onData = () => refresh();
  store.addEventListener('data', onData);
  refresh();

  return () => {
    store.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
