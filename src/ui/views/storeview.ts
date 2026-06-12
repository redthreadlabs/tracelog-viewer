/**
 * Store inspector (#/store): what the in-memory store is holding — every
 * loaded file with its sizes, record counts by kind (as a proportional
 * stacked bar in the kind palette), and a per-file evict button that
 * actually frees the memory (per-file intern pools make this true; see
 * parse.ts).
 */
import { el, clear } from '../dom';
import { store } from '../../data/store';
import { RECORD_KINDS, type RecordKind } from '../../data/types';
import { fmtBytes, fmtCount, fmtDateTime, fmtHumane, zoneLabel } from '../format';

const KIND_DESCRIPTIONS: Record<RecordKind, string> = {
  transaction: 'top-level units of work (requests, jobs)',
  span: 'timed operations within a transaction (db, http, …)',
  error: 'captured exceptions and log errors',
  event: 'custom app events and log lines',
  metricset: 'runtime and breakdown metric samples',
};

interface FileRow {
  key: string;
  channel: string;
  interval: string;
  host: string;
  current: boolean;
  evicted: boolean;
  sizeCompressed: number;
  sizeUncompressed: number;
  lastModified?: number;
  total: number;
  byKind: Map<RecordKind, number>;
}

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

export function renderStoreView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  const tip = el('div', { className: 'chart-tooltip fixed' });
  container.append(body, tip);

  // the heap column refreshes in place while the page is open
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

  function buildRows(): FileRow[] {
    const rows = new Map<string, FileRow>();
    for (const info of store.files.values()) {
      rows.set(info.key, {
        key: info.key,
        channel: info.channel,
        interval: info.interval,
        host: info.host,
        current: info.current,
        evicted: info.evicted,
        sizeCompressed: info.sizeCompressed,
        sizeUncompressed: info.sizeUncompressed,
        lastModified: info.lastModified,
        total: 0,
        byKind: new Map(),
      });
    }
    for (const rec of store.records) {
      let row = rows.get(rec.sourceKey);
      if (!row) {
        // a file the registry somehow missed — synthesize from the record
        row = {
          key: rec.sourceKey,
          channel: rec.channel,
          interval: '',
          host: rec.host,
          current: false,
          evicted: false,
          sizeCompressed: 0,
          sizeUncompressed: 0,
          total: 0,
          byKind: new Map(),
        };
        rows.set(rec.sourceKey, row);
      }
      row.total++;
      row.byKind.set(rec.kind, (row.byKind.get(rec.kind) ?? 0) + 1);
    }
    return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function render(): void {
    clear(body);
    const rows = buildRows();

    if (rows.length === 0) {
      renderMemory();
      body.append(
        el('div', { className: 'store-summary' }, [heapCol]),
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'The store is empty' }),
          el('p', { text: 'Run a scan; every loaded file will be inventoried here.' }),
        ]),
      );
      return;
    }

    // --- one summary panel: store ledger | heap ledger, kind bar below ---
    const storeCol = el('div', { className: 'sgrid' });
    storeCol.append(el('div', { className: 'label scol-title', text: 'In memory' }));
    const srow = (label: string, value: string) =>
      storeCol.append(
        el('div', { className: 'srow' }, [
          el('span', { className: 'label', text: label }),
          el('span', { className: 'num', text: value }),
        ]),
      );
    srow('records', fmtCount(store.records.length));
    srow('files', fmtCount(rows.length));
    srow(
      'compressed → parsed',
      `${fmtBytes(rows.reduce((s, r) => s + r.sizeCompressed, 0))} → ${fmtBytes(rows.reduce((s, r) => s + r.sizeUncompressed, 0))}`,
    );

    renderMemory();

    const overall = totalKindBar();
    body.append(
      el('div', { className: 'store-summary' }, [
        storeCol,
        el('div', { className: 'sdivider' }),
        heapCol,
        overall,
      ]),
    );

    // --- per-file table ---
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Loaded files' }),
        el('span', {
          className: 'budget faint',
          text: 'evicting frees the file’s records and their strings (per-file intern pools); a live file returns on its next change',
        }),
      ]),
    );

    const table = el('table', { className: 'records txn-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          th('file', ''),
          th('modified', 'width:120px'),
          th('records', 'width:100px;text-align:right'),
          th('kinds', 'width:22%'),
          th('compressed', 'width:110px;text-align:right'),
          th('uncompressed', 'width:120px;text-align:right'),
          el('th', { attrs: { style: 'width:90px' } }),
        ]),
      ]),
    );
    const tbody = el('tbody');
    for (const row of rows) {
      const evictBtn = el('button', {
        className: 'btn btn-quiet',
        text: row.evicted ? 'evicted' : 'evict',
        title: 'drop this file’s records from memory',
        on: {
          click: (ev) => {
            ev.stopPropagation();
            store.evictFile(row.key);
          },
        },
      });
      evictBtn.disabled = row.evicted || row.total === 0;

      const tr = el('tr', { className: row.evicted ? 'evicted-row' : '' }, [
        el('td', { className: 'mono', text: row.key, title: row.key }),
        el('td', {
          className: 'num',
          text: row.lastModified ? fmtHumane(row.lastModified) : '',
          title: row.lastModified
            ? `${fmtDateTime(row.lastModified)} ${zoneLabel()}`
            : undefined,
        }),
        el('td', {
          className: 'num',
          text: row.evicted ? '—' : fmtCount(row.total),
          attrs: { style: 'text-align:right' },
        }),
        el('td', {}, [kindBar(row)]),
        el('td', {
          className: 'num',
          text: row.sizeCompressed > 0 ? fmtBytes(row.sizeCompressed) : '',
          attrs: { style: 'text-align:right' },
        }),
        el('td', {
          className: 'num',
          text: row.sizeUncompressed > 0 ? fmtBytes(row.sizeUncompressed) : '',
          attrs: { style: 'text-align:right' },
        }),
        el('td', { attrs: { style: 'text-align:right' } }, [evictBtn]),
      ]);
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [table]));
  }

  function totalKindBar(): HTMLElement {
    const byKind = new Map<RecordKind, number>();
    for (const kind of RECORD_KINDS) {
      const count = store.kindCounts.get(kind) ?? 0;
      if (count > 0) byKind.set(kind, count);
    }
    const bar = segments(byKind, store.records.length);
    bar.classList.add('store-kindbar');
    return bar;
  }

  function kindBar(row: FileRow): HTMLElement {
    return segments(row.byKind, row.total);
  }

  function segments(byKind: Map<RecordKind, number>, total: number): HTMLElement {
    const bar = el('div', { className: 'kind-bar' });
    if (total === 0) return bar;
    for (const kind of RECORD_KINDS) {
      const count = byKind.get(kind) ?? 0;
      if (count === 0) continue;
      const seg = el('span', {
        attrs: { style: `background: var(--kind-${kind}); flex: ${count}` },
        on: {
          mousemove: (ev) => {
            tip.innerHTML =
              `<div class="t"><span class="dot" style="background: var(--kind-${kind})"></span>` +
              `${kind} — ${KIND_DESCRIPTIONS[kind]}</div>` +
              `<span class="row">records<span class="v">${fmtCount(count)} of ${fmtCount(total)}</span></span>`;
            tip.style.display = 'block';
            tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - 300)}px`;
            tip.style.top = `${ev.clientY - 10}px`;
          },
          mouseleave: () => {
            tip.style.display = 'none';
          },
        },
      });
      bar.append(seg);
    }
    return bar;
  }

  const onData = () => render();
  store.addEventListener('data', onData);
  render();

  return () => {
    clearInterval(memTimer);
    store.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
