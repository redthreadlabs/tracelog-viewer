/**
 * Viewer performance (#/internals/perf): the app watching itself. A log of
 * internal timings — listings, fetches, parses, scans, renders, live ticks,
 * main-thread stalls — newest first, with throughput aggregates and a
 * copy-as-JSON export for sharing stress-run numbers (SPEC §8.1: these are
 * the measurements LIMITS.md is built from).
 */
import { el, clear } from '../dom';
import { perf, type PerfEntry, type PerfCategory } from '../../data/perf';
import { internalsTabs } from './internals';
import { fmtBytes, fmtCount, fmtDuration, fmtDateTime, fmtHumane } from '../format';

const PAGE_SIZE = 100;

const CATEGORY_COLOR: Record<PerfCategory, string> = {
  list: '#29c3f2',
  fetch: '#2502ba',
  parse: '#057a05',
  scan: '#de8502',
  render: '#8202c7',
  live: '#fd0366',
  stall: '#c2081d',
};

/** Past these, an operation's duration renders emphasized. */
const SLOW_MS: Record<PerfCategory, number> = {
  list: 2000,
  fetch: 3000,
  parse: 500,
  scan: 5000,
  render: 100,
  live: 3000,
  stall: 0, // a stall is slow by definition
};

/** Chrome's non-standard per-tab JS heap numbers (absent elsewhere). */
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readHeap(): PerformanceMemory | null {
  const mem = (performance as unknown as { memory?: PerformanceMemory }).memory;
  return mem && typeof mem.usedJSHeapSize === 'number' ? mem : null;
}

/** total bytes / total seconds across entries that carried bytes */
function throughput(entries: PerfEntry[]): string {
  let bytes = 0;
  let ms = 0;
  for (const entry of entries) {
    if (entry.bytes) {
      bytes += entry.bytes;
      ms += entry.ms;
    }
  }
  if (ms <= 0) return '—';
  return `${fmtBytes((bytes / ms) * 1000)}/s`;
}

export function renderPerfView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  container.append(body);

  let page = 0;

  // --- summary: session ledger | throughput | tab heap ---

  function sgridCol(title: string): { col: HTMLElement; srow: (l: string, v: string) => void } {
    const col = el('div', { className: 'sgrid' });
    col.append(el('div', { className: 'label scol-title', text: title }));
    return {
      col,
      srow: (label: string, value: string) =>
        col.append(
          el('div', { className: 'srow' }, [
            el('span', { className: 'label', text: label }),
            el('span', { className: 'num', text: value }),
          ]),
        ),
    };
  }

  const heapCol = el('div', { className: 'sgrid' });
  function renderMemory(): void {
    clear(heapCol);
    const heap = readHeap();
    heapCol.append(el('div', { className: 'label scol-title', text: 'Tab heap' }));
    if (!heap) {
      heapCol.append(
        el('div', {
          className: 'faint',
          text: 'unavailable in this browser (Chromium only)',
          attrs: { style: 'font-size:12px' },
        }),
      );
      return;
    }
    const srow = (label: string, value: string) =>
      heapCol.append(
        el('div', { className: 'srow' }, [
          el('span', { className: 'label', text: label }),
          el('span', { className: 'num', text: value }),
        ]),
      );
    srow('used', fmtBytes(heap.usedJSHeapSize));
    srow('allocated', fmtBytes(heap.totalJSHeapSize));
    srow('of limit', `${Math.round((heap.usedJSHeapSize / heap.jsHeapSizeLimit) * 100)}%`);
  }
  const memTimer = setInterval(renderMemory, 2000);

  function render(): void {
    clear(body);
    body.append(internalsTabs('/internals/perf'));

    const entries = perf.entries;
    const stalls = entries.filter((e) => e.cat === 'stall');
    const netFetches = entries.filter((e) => e.cat === 'fetch' && !e.cached);
    const cacheFetches = entries.filter((e) => e.cat === 'fetch' && e.cached);
    const parses = entries.filter((e) => e.cat === 'parse');

    const session = sgridCol('Session');
    session.srow('timings', fmtCount(entries.length));
    session.srow(
      'since',
      entries.length > 0 ? fmtHumane(entries[0].ts) : '—',
    );
    session.srow(
      'main-thread stalls',
      stalls.length > 0
        ? `${fmtCount(stalls.length)} · worst ${fmtDuration(Math.max(...stalls.map((s) => s.ms)))}`
        : 'none observed',
    );

    const speed = sgridCol('Throughput');
    speed.srow('network', netFetches.length > 0 ? throughput(netFetches) : '—');
    speed.srow('local cache', cacheFetches.length > 0 ? throughput(cacheFetches) : '—');
    speed.srow('parse', parses.length > 0 ? throughput(parses) : '—');

    renderMemory();
    body.append(
      el('div', { className: 'store-summary' }, [
        session.col,
        el('div', { className: 'sdivider' }),
        speed.col,
        el('div', { className: 'sdivider' }),
        heapCol,
      ]),
    );

    // --- log header with actions ---
    const copyBtn = el('button', {
      className: 'btn btn-quiet',
      text: 'copy as JSON',
      title: 'copy the whole log to the clipboard — paste it into an issue or a LIMITS.md run',
      on: {
        click: () => {
          void navigator.clipboard.writeText(perf.exportJson()).then(() => {
            copyBtn.textContent = 'copied ✓';
            setTimeout(() => (copyBtn.textContent = 'copy as JSON'), 1500);
          });
        },
      },
    });
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Timings' }),
        el('span', { className: 'masthead-spacer' }),
        el('span', {
          className: 'budget faint',
          text: 'newest first — durations are wall time on the main thread',
        }),
        copyBtn,
        el('button', {
          className: 'btn btn-quiet',
          text: 'clear',
          on: { click: () => perf.clear() },
        }),
      ]),
    );

    if (entries.length === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'Nothing measured yet' }),
          el('p', { text: 'Load a range, switch views, or let live mode tick — timings land here.' }),
        ]),
      );
      return;
    }

    // --- the log, newest first ---
    const newestFirst = [...entries].reverse();
    const pages = Math.max(1, Math.ceil(newestFirst.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);

    const table = el('table', { className: 'records txn-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          th('when', 'width:110px'),
          th('what', 'width:90px'),
          th('operation', ''),
          th('records', 'width:90px;text-align:right'),
          th('bytes', 'width:90px;text-align:right'),
          th('took', 'width:90px;text-align:right'),
        ]),
      ]),
    );
    const tbody = el('tbody');
    const start = page * PAGE_SIZE;
    const now = Date.now();
    for (const entry of newestFirst.slice(start, start + PAGE_SIZE)) {
      tbody.append(entryRow(entry, now));
    }
    table.append(tbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [table]));

    if (pages > 1) {
      const pager = el('div', {
        className: 'pagerbar',
        attrs: { style: 'margin:0 0 16px;border-radius:var(--radius-lg)' },
      });
      const btn = (text: string, target: number, disabled: boolean) => {
        const b = el('button', {
          className: 'btn btn-quiet',
          text,
          on: {
            click: () => {
              page = target;
              render();
            },
          },
        });
        b.disabled = disabled;
        return b;
      };
      pager.append(
        el('span', { className: 'budget', text: `${fmtCount(newestFirst.length)} timings` }),
        el('span', { className: 'masthead-spacer' }),
        btn('⇤', 0, page === 0),
        btn('‹ newer', page - 1, page === 0),
        el('span', { className: 'budget', text: `page ${fmtCount(page + 1)} of ${fmtCount(pages)}` }),
        btn('older ›', page + 1, page >= pages - 1),
        btn('⇥', pages - 1, page >= pages - 1),
      );
      body.append(pager);
    }
  }

  function entryRow(entry: PerfEntry, now: number): HTMLElement {
    const slow = entry.ms >= SLOW_MS[entry.cat];
    const operation = el('td', {}, [
      el('span', { text: entry.name }),
      ...(entry.detail
        ? [el('span', { className: 'faint', text: ` — ${entry.detail}` })]
        : []),
      ...(entry.cat === 'fetch'
        ? [el('span', { className: 'faint', text: entry.cached ? ' — cache' : ' — network' })]
        : []),
    ]);
    return el('tr', {}, [
      el('td', {
        className: 'faint',
        text: fmtHumane(entry.ts, now),
        attrs: { title: fmtDateTime(entry.ts) },
      }),
      el('td', {}, [
        el('span', { className: 'kind-stat' }, [
          el('span', {
            className: 'dot',
            attrs: { style: `background:${CATEGORY_COLOR[entry.cat]}` },
          }),
          el('span', { text: entry.cat }),
        ]),
      ]),
      operation,
      el('td', {
        className: 'num',
        text: entry.records !== undefined ? fmtCount(entry.records) : '',
        attrs: { style: 'text-align:right' },
      }),
      el('td', {
        className: 'num',
        text: entry.bytes !== undefined ? fmtBytes(entry.bytes) : '',
        attrs: { style: 'text-align:right' },
      }),
      el('td', {
        className: 'num',
        text: fmtDuration(entry.ms),
        attrs: {
          style: `text-align:right${slow ? ';color:var(--thread);font-weight:600' : ''}`,
        },
      }),
    ]);
  }

  function th(text: string, style: string): HTMLElement {
    return el('th', { text, attrs: style ? { style } : {} });
  }

  // New entries land while the page is open: re-render at most once a frame.
  let raf = 0;
  const onEntry = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };
  perf.addEventListener('entry', onEntry);

  render();

  return () => {
    clearInterval(memTimer);
    perf.removeEventListener('entry', onEntry);
    if (raf) cancelAnimationFrame(raf);
  };
}
