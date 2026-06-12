/**
 * Store inspector (#/store): the full file inventory of the bucket —
 * everything available in S3, newest first, paginated — overlaid with
 * what's currently in memory and what's cached locally in IndexedDB.
 * A file is simply loaded or not: unloaded rows are greyed with a "load"
 * action; loaded rows show record counts (kind bar) and an "evict" action.
 * Per-file intern pools make eviction actually free the memory (see
 * parse.ts). Plus a live tab-heap readout.
 */
import { el, clear } from '../dom';
import { store } from '../../data/store';
import { loadOneFile } from '../../data/scan';
import { cacheKeys } from '../../data/cache';
import type { LogBucket } from '../../s3/client';
import { parseKey, dedupeCurrents, type ParsedKey } from '../../s3/keys';
import { RECORD_KINDS, type RecordKind } from '../../data/types';
import { fmtBytes, fmtCount, fmtDateTime, fmtHumane, zoneLabel } from '../format';

const PAGE_SIZE = 50;

const KIND_DESCRIPTIONS: Record<RecordKind, string> = {
  transaction: 'top-level units of work (requests, jobs)',
  span: 'timed operations within a transaction (db, http, …)',
  error: 'captured exceptions and log errors',
  event: 'custom app events and log lines',
  metricset: 'runtime and breakdown metric samples',
};

interface FileRow {
  parsed: ParsedKey;
  /** records currently in memory for this key */
  total: number;
  byKind: Map<RecordKind, number>;
  sizeUncompressed: number;
  lastModified?: number;
  cached: boolean;
  loading?: boolean;
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

export function renderStoreView(container: HTMLElement, bucket: LogBucket): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  const tip = el('div', { className: 'chart-tooltip fixed' });
  container.append(body, tip);

  let available: ParsedKey[] | null = null; // null = still listing
  let cachedSet = new Set<string>();
  let listError: string | null = null;
  let page = 0;
  const inFlight = new Set<string>();

  async function loadAvailability(): Promise<void> {
    try {
      const [channels, cached] = await Promise.all([bucket.listChannels(), cacheKeys(bucket.bucket)]);
      cachedSet = cached;
      const listings = await Promise.all(
        channels.map((ch) => bucket.listChannelRange(ch, '0000-01-01', '9999-12-31')),
      );
      const all: ParsedKey[] = [];
      for (const listing of listings) {
        for (const obj of listing) {
          const parsed = parseKey(obj.key, obj.size, obj.lastModified, obj.etag);
          if (parsed) all.push(parsed);
        }
      }
      // newest first: interval desc, then key for stability
      available = dedupeCurrents(all).sort((a, b) =>
        a.interval === b.interval
          ? a.key.localeCompare(b.key)
          : b.interval.localeCompare(a.interval),
      );
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  async function refreshCached(): Promise<void> {
    cachedSet = await cacheKeys(bucket.bucket);
  }

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
    const counts = new Map<string, { total: number; byKind: Map<RecordKind, number> }>();
    for (const rec of store.records) {
      let c = counts.get(rec.sourceKey);
      if (!c) {
        c = { total: 0, byKind: new Map() };
        counts.set(rec.sourceKey, c);
      }
      c.total++;
      c.byKind.set(rec.kind, (c.byKind.get(rec.kind) ?? 0) + 1);
    }

    const rows: FileRow[] = [];
    const seen = new Set<string>();
    for (const parsed of available ?? []) {
      seen.add(parsed.key);
      const c = counts.get(parsed.key);
      const info = store.files.get(parsed.key);
      rows.push({
        parsed,
        total: c?.total ?? 0,
        byKind: c?.byKind ?? new Map(),
        sizeUncompressed: info?.sizeUncompressed ?? 0,
        lastModified: parsed.lastModified?.getTime() ?? info?.lastModified,
        cached: cachedSet.has(parsed.key),
        loading: inFlight.has(parsed.key),
      });
    }
    // loaded files the listing missed (e.g. listing failed) still appear
    for (const info of store.files.values()) {
      if (seen.has(info.key)) continue;
      const parsed = parseKey(info.key, info.sizeCompressed);
      if (!parsed) continue;
      const c = counts.get(info.key);
      rows.push({
        parsed,
        total: c?.total ?? 0,
        byKind: c?.byKind ?? new Map(),
        sizeUncompressed: info.sizeUncompressed,
        lastModified: info.lastModified,
        cached: cachedSet.has(info.key),
        loading: inFlight.has(info.key),
      });
    }
    return rows;
  }

  function maxPage(rows: FileRow[]): number {
    return Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  }

  function render(): void {
    clear(body);
    const rows = buildRows();
    page = Math.min(page, maxPage(rows));

    // --- summary panel: store ledger | heap ledger | kinds ---
    const storeCol = el('div', { className: 'sgrid' });
    storeCol.append(el('div', { className: 'label scol-title', text: 'In memory' }));
    const srow = (label: string, value: string) =>
      storeCol.append(
        el('div', { className: 'srow' }, [
          el('span', { className: 'label', text: label }),
          el('span', { className: 'num', text: value }),
        ]),
      );
    const loadedRows = rows.filter((r) => r.total > 0);
    srow('records', fmtCount(store.records.length));
    srow('files', `${fmtCount(loadedRows.length)} of ${fmtCount(rows.length)}`);
    srow(
      'compressed → parsed',
      `${fmtBytes(loadedRows.reduce((s, r) => s + r.parsed.size, 0))} → ${fmtBytes(loadedRows.reduce((s, r) => s + r.sizeUncompressed, 0))}`,
    );
    srow('cached locally', fmtCount(rows.filter((r) => r.cached).length));

    renderMemory();
    body.append(
      el('div', { className: 'store-summary' }, [
        storeCol,
        el('div', { className: 'sdivider' }),
        heapCol,
        el('div', { className: 'sdivider' }),
        totalKindStats(),
      ]),
    );

    // --- file inventory ---
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Files in S3' }),
        el('span', { className: 'masthead-spacer' }),
        el('span', {
          className: 'budget faint',
          text:
            listError ??
            (available === null
              ? 'listing the bucket…'
              : 'newest first — ⌂ = cached locally (free to load); live snapshots are never cached'),
        }),
      ]),
    );

    if (rows.length === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: available === null ? 'Listing…' : 'The bucket is empty' }),
        ]),
      );
      return;
    }

    const table = el('table', { className: 'records txn-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          th('file', ''),
          th('modified', 'width:110px'),
          th('records', 'width:90px;text-align:right'),
          th('kinds', 'width:18%'),
          th('compressed', 'width:100px;text-align:right'),
          th('parsed', 'width:90px;text-align:right'),
          th('cached', 'width:64px;text-align:center'),
          el('th', { attrs: { style: 'width:84px' } }),
        ]),
      ]),
    );
    const tbody = el('tbody');
    const start = page * PAGE_SIZE;
    for (const row of rows.slice(start, start + PAGE_SIZE)) {
      tbody.append(fileRow(row));
    }
    table.append(tbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [table]));

    // pager — newest first, so "older" pages backward in time
    const pages = maxPage(rows) + 1;
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
        el('span', { className: 'budget', text: `${fmtCount(rows.length)} files` }),
        el('span', { className: 'masthead-spacer' }),
        btn('⇤', 0, page === 0),
        btn('‹ newer', page - 1, page === 0),
        el('span', { className: 'budget', text: `page ${fmtCount(page + 1)} of ${fmtCount(pages)}` }),
        btn('older ›', page + 1, page >= maxPage(rows)),
        btn('⇥', maxPage(rows), page >= maxPage(rows)),
      );
      body.append(pager);
    }
  }

  function fileRow(row: FileRow): HTMLElement {
    const loaded = row.total > 0;
    const action = el('button', {
      className: 'btn btn-quiet',
      text: row.loading ? 'loading…' : loaded ? 'evict' : 'load',
      title: loaded ? 'drop this file’s records from memory' : 'fetch and parse this file',
      on: {
        click: (ev) => {
          ev.stopPropagation();
          if (row.loading) return;
          if (loaded) {
            store.dropFile(row.parsed.key);
          } else {
            inFlight.add(row.parsed.key);
            render();
            void loadOneFile(bucket, row.parsed)
              .then(refreshCached)
              .finally(() => {
                inFlight.delete(row.parsed.key);
                render();
              });
          }
        },
      },
    });
    action.disabled = !!row.loading;

    const tr = el('tr', { className: loaded ? '' : 'evicted-row' }, [
      el('td', { className: 'mono', text: row.parsed.key, title: row.parsed.key }),
      el('td', {
        className: 'num',
        text: row.lastModified ? fmtHumane(row.lastModified) : '',
        title: row.lastModified ? `${fmtDateTime(row.lastModified)} ${zoneLabel()}` : undefined,
      }),
      el('td', {
        className: 'num',
        text: loaded ? fmtCount(row.total) : '—',
        attrs: { style: 'text-align:right' },
      }),
      el('td', {}, [kindBar(row)]),
      el('td', {
        className: 'num',
        text: row.parsed.size > 0 ? fmtBytes(row.parsed.size) : '',
        attrs: { style: 'text-align:right' },
      }),
      el('td', {
        className: 'num',
        text: loaded && row.sizeUncompressed > 0 ? fmtBytes(row.sizeUncompressed) : '',
        attrs: { style: 'text-align:right' },
      }),
      el('td', {
        className: row.cached ? 'num' : 'num faint',
        text: row.cached ? '⌂' : row.parsed.current ? 'live' : '',
        title: row.cached
          ? 'cached locally in IndexedDB — loading this file is free'
          : row.parsed.current
            ? 'live snapshot — changes every upload, so it is never cached'
            : 'will be cached after its first load once finalized',
        attrs: { style: 'text-align:center' },
      }),
      el('td', { attrs: { style: 'text-align:right' } }, [action]),
    ]);
    return tr;
  }

  function totalKindStats(): HTMLElement {
    const col = el('div', { className: 'sgrid' });
    col.append(el('div', { className: 'label scol-title', text: 'Kinds' }));
    const total = store.records.length;
    for (const kind of RECORD_KINDS) {
      const count = store.kindCounts.get(kind) ?? 0;
      if (count === 0) continue;
      const pct = Math.round((count / total) * 100);
      col.append(
        el('div', { className: 'srow', title: KIND_DESCRIPTIONS[kind] }, [
          el('span', { className: 'kind-stat' }, [
            el('span', { className: 'dot', attrs: { style: `background: var(--kind-${kind})` } }),
            el('span', { text: kind }),
          ]),
          el('span', { className: 'num', text: `${fmtCount(count)} (${pct < 1 ? '<1' : pct}%)` }),
        ]),
      );
    }
    if (total === 0) {
      col.append(
        el('div', { className: 'faint', text: 'nothing loaded', attrs: { style: 'font-size:12px' } }),
      );
    }
    return col;
  }

  function kindBar(row: FileRow): HTMLElement {
    const bar = el('div', { className: 'kind-bar' });
    if (row.total === 0) return bar;
    for (const kind of RECORD_KINDS) {
      const count = row.byKind.get(kind) ?? 0;
      if (count === 0) continue;
      const seg = el('span', {
        attrs: { style: `background: var(--kind-${kind}); flex: ${count}` },
        on: {
          mousemove: (ev) => {
            tip.innerHTML =
              `<div class="t"><span class="dot" style="background: var(--kind-${kind})"></span>` +
              `${kind} — ${KIND_DESCRIPTIONS[kind]}</div>` +
              `<span class="row">records<span class="v">${fmtCount(count)} of ${fmtCount(row.total)}</span></span>`;
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
  void loadAvailability();

  return () => {
    clearInterval(memTimer);
    store.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
