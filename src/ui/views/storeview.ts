/**
 * Store inspector (#/internals/store): the full file inventory of the bucket —
 * everything available in S3, newest first, paginated — overlaid with
 * what's currently in memory and what's cached locally in IndexedDB.
 * A file is simply loaded or not: unloaded rows are greyed with a "load"
 * action; loaded rows show record counts (kind bar) and an "evict" action.
 * Per-file intern pools make eviction actually free the memory (see
 * parse.ts). Plus a live tab-heap readout.
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { parseKey, type ParsedKey } from '../../s3/keys';
import { RECORD_KINDS, type RecordKind } from '../../data/types';
import { internalsTabs } from './internals';
import { fmtBytes, fmtCount, fmtDateTime, fmtHumane, zoneLabel } from '../format';

const PAGE_SIZE = 50;

/** Dimensions the file listing can be rolled up by (in display/column order). */
type RollupDim = 'interval' | 'channel' | 'host';
const ROLLUP_DIMS: { key: RollupDim; label: string }[] = [
  { key: 'interval', label: 'by interval' },
  { key: 'channel', label: 'by channel' },
  { key: 'host', label: 'by host' },
];

interface RollupGroup {
  keyParts: string[];
  files: number; // all files in the group (from the listing)
  loaded: number; // files currently in memory (records > 0)
  records: number; // records from the loaded files
  compressed: number; // sum over ALL files (listing size, always known)
  loadedCompressed: number; // sum over loaded files — for the measured ratio
  loadedParsed: number; // sum over loaded files — for the measured ratio
  cached: number;
}

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

export function renderStoreView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  const tip = el('div', { className: 'chart-tooltip fixed' });
  container.append(body, tip);

  let available: ParsedKey[] | null = null; // null = still listing
  let cachedSet = new Set<string>();
  let listError: string | null = null;
  let page = 0;
  const inFlight = new Set<string>();
  // file-listing rollups: a [Rollups] toggle reveals by-interval/channel/host
  // checkboxes; any checked dimension switches the listing to aggregated totals
  let rollupsOpen = false;
  const rollupDims = new Set<RollupDim>();

  async function loadAvailability(): Promise<void> {
    try {
      const [files, cached] = await Promise.all([
        storeClient.request<ParsedKey[]>('listAllFiles'),
        storeClient.request<Set<string>>('cacheKeys'),
      ]);
      cachedSet = cached;
      available = files; // already deduped, newest first (worker-side)
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  async function refreshCached(): Promise<void> {
    cachedSet = await storeClient.request<Set<string>>('cacheKeys');
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

  // per-file kind counts arrive from the worker with each data event
  let kindCountsByFile = new Map<string, Map<RecordKind, number>>();
  async function refreshKindCounts(): Promise<void> {
    kindCountsByFile = await storeClient.request<Map<string, Map<RecordKind, number>>>(
      'fileKindCounts',
    );
    render();
  }

  function buildRows(): FileRow[] {
    const counts = new Map<string, { total: number; byKind: Map<RecordKind, number> }>();
    for (const [key, byKind] of kindCountsByFile) {
      let total = 0;
      for (const n of byKind.values()) total += n;
      counts.set(key, { total, byKind });
    }

    const rows: FileRow[] = [];
    const seen = new Set<string>();
    for (const parsed of available ?? []) {
      seen.add(parsed.key);
      const c = counts.get(parsed.key);
      const info = storeFiles().get(parsed.key);
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
    for (const info of storeFiles().values()) {
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

  function storeFiles(): Map<string, import('../../data/store').FileInfo> {
    return new Map(storeClient.snapshot.files.map((f) => [f.key, f]));
  }

  function maxPage(rows: FileRow[]): number {
    return Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  }

  function render(): void {
    clear(body);
    body.append(internalsTabs('/internals/store'));
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
    srow('records', fmtCount(storeClient.snapshot.recordCount));
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

    // --- file inventory (optionally rolled up by interval/channel/host) ---
    const activeDims = ROLLUP_DIMS.filter((d) => rollupDims.has(d.key)).map((d) => d.key);
    const rollupActive = rollupsOpen && activeDims.length > 0;
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Files in S3' }),
        rollupButton(),
        el('span', { className: 'masthead-spacer' }),
        el('span', {
          className: 'budget faint',
          text:
            listError ??
            (available === null
              ? 'listing the bucket…'
              : rollupActive
                ? 'rolled up — files/compressed/decompressed cover all files (decompressed estimated); loaded & records are what is in memory'
                : 'newest first — ⌂ = cached locally (free to load); live snapshots are never cached'),
        }),
      ]),
    );
    if (rollupsOpen) body.append(rollupControls());

    if (rows.length === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: available === null ? 'Listing…' : 'The bucket is empty' }),
        ]),
      );
      return;
    }

    if (rollupActive) {
      body.append(
        el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [
          rollupTable(rows, activeDims),
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
            void storeClient.request('dropFile', { key: row.parsed.key });
          } else {
            inFlight.add(row.parsed.key);
            render();
            void storeClient
              .request('loadOneFile', { file: row.parsed })
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
    const total = storeClient.snapshot.recordCount;
    for (const kind of RECORD_KINDS) {
      const count = storeClient.snapshot.kindCounts.get(kind) ?? 0;
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

  // ---------------------------------------------------------------- rollups
  function rollupButton(): HTMLElement {
    return el('button', {
      className: rollupsOpen ? 'btn btn-quiet on' : 'btn btn-quiet',
      text: 'Rollups',
      title: 'aggregate the file listing by interval, channel, and/or host',
      on: {
        click: () => {
          rollupsOpen = !rollupsOpen;
          render();
        },
      },
    });
  }

  function rollupControls(): HTMLElement {
    const wrap = el('div', { className: 'rollup-controls' });
    for (const d of ROLLUP_DIMS) {
      const cb = el('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
      cb.checked = rollupDims.has(d.key);
      cb.addEventListener('change', () => {
        if (cb.checked) rollupDims.add(d.key);
        else rollupDims.delete(d.key);
        render();
      });
      wrap.append(el('label', { className: 'rollup-check' }, [cb, el('span', { text: d.label })]));
    }
    return wrap;
  }

  function dimValue(p: ParsedKey, d: RollupDim): string {
    return d === 'interval' ? p.interval : d === 'channel' ? p.channel : p.host;
  }

  function buildRollups(rows: FileRow[], dims: RollupDim[]): RollupGroup[] {
    const map = new Map<string, RollupGroup>();
    for (const r of rows) {
      const parts = dims.map((d) => dimValue(r.parsed, d));
      const id = parts.join(' ');
      let g = map.get(id);
      if (!g) {
        g = {
          keyParts: parts,
          files: 0,
          loaded: 0,
          records: 0,
          compressed: 0,
          loadedCompressed: 0,
          loadedParsed: 0,
          cached: 0,
        };
        map.set(id, g);
      }
      g.files++;
      g.compressed += r.parsed.size;
      if (r.cached) g.cached++;
      if (r.total > 0) {
        g.loaded++;
        g.records += r.total;
        g.loadedCompressed += r.parsed.size;
        g.loadedParsed += r.sizeUncompressed;
      }
    }
    // newest interval first; channel/host ascending
    return [...map.values()].sort((a, b) => {
      for (let i = 0; i < dims.length; i++) {
        const cmp =
          dims[i] === 'interval'
            ? b.keyParts[i].localeCompare(a.keyParts[i])
            : a.keyParts[i].localeCompare(b.keyParts[i]);
        if (cmp) return cmp;
      }
      return 0;
    });
  }

  function rollupTable(rows: FileRow[], dims: RollupDim[]): HTMLElement {
    const groups = buildRollups(rows, dims);
    // one measured compression ratio across everything loaded, as the fallback
    // for groups with nothing loaded yet (matches the size-ledger's overall ratio)
    const gC = groups.reduce((s, g) => s + g.loadedCompressed, 0);
    const gP = groups.reduce((s, g) => s + g.loadedParsed, 0);
    const globalRatio = gC > 0 ? gP / gC : 10;
    // estimated full decompressed bytes for a group (all files), using the
    // group's own measured ratio when it has loaded files, else the global one
    const estDecomp = (g: RollupGroup): number =>
      g.compressed * (g.loadedCompressed > 0 ? g.loadedParsed / g.loadedCompressed : globalRatio);

    const num = (text: string) =>
      el('td', { className: 'num', text, attrs: { style: 'text-align:right' } });
    const decomp = (g: RollupGroup) =>
      el('td', {
        className: g.loadedCompressed > 0 ? 'num' : 'num faint',
        text: `~${fmtBytes(estDecomp(g))}`,
        title:
          g.loadedCompressed > 0
            ? 'estimated full size from this group’s measured compression ratio'
            : 'estimated at the default 10× (nothing loaded here yet to measure)',
        attrs: { style: 'text-align:right' },
      });

    const table = el('table', { className: 'records txn-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          ...dims.map((d) => th(d, '')),
          th('files', 'width:60px;text-align:right'),
          th('compressed', 'width:100px;text-align:right'),
          th('decompressed', 'width:110px;text-align:right'),
          th('loaded', 'width:60px;text-align:right'),
          th('records', 'width:90px;text-align:right'),
          th('cached', 'width:70px;text-align:right'),
        ]),
      ]),
    );
    const tbody = el('tbody');
    for (const g of groups) {
      tbody.append(
        el('tr', {}, [
          ...g.keyParts.map((v) => el('td', { className: 'mono', text: v })),
          num(fmtCount(g.files)),
          num(fmtBytes(g.compressed)),
          decomp(g),
          num(g.loaded > 0 ? fmtCount(g.loaded) : '—'),
          num(g.records > 0 ? fmtCount(g.records) : '—'),
          num(`${fmtCount(g.cached)}/${fmtCount(g.files)}`),
        ]),
      );
    }
    table.append(tbody);

    if (groups.length > 1) {
      const t = groups.reduce(
        (a, g) => ({
          files: a.files + g.files,
          compressed: a.compressed + g.compressed,
          decomp: a.decomp + estDecomp(g),
          loaded: a.loaded + g.loaded,
          records: a.records + g.records,
          cached: a.cached + g.cached,
        }),
        { files: 0, compressed: 0, decomp: 0, loaded: 0, records: 0, cached: 0 },
      );
      table.append(
        el('tfoot', {}, [
          el('tr', { className: 'rollup-total' }, [
            el('td', { className: 'label', text: 'all', attrs: { colspan: String(dims.length) } }),
            num(fmtCount(t.files)),
            num(fmtBytes(t.compressed)),
            num(`~${fmtBytes(t.decomp)}`),
            num(t.loaded > 0 ? fmtCount(t.loaded) : '—'),
            num(t.records > 0 ? fmtCount(t.records) : '—'),
            num(fmtCount(t.cached)),
          ]),
        ]),
      );
    }
    return table;
  }

  const onData = () => void refreshKindCounts();
  storeClient.addEventListener('data', onData);
  render();
  void refreshKindCounts();
  void loadAvailability();

  return () => {
    clearInterval(memTimer);
    storeClient.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
