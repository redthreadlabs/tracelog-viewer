/**
 * Store inspector (#/internals/store): the full file inventory of the bucket —
 * everything available in S3, newest first, paginated — overlaid with
 * what's currently in memory and what's cached locally in IndexedDB.
 * A file is simply loaded or not: unloaded rows are greyed with a "load"
 * action; loaded rows show record counts (kind bar) and an "evict" action.
 * Per-file intern pools make eviction actually free the memory (see
 * parse.ts).
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { parseKey, type ParsedKey } from '../../s3/keys';
import { RECORD_KINDS, type RecordKind } from '../../data/types';
import { internalsTabs } from './internals';
import { fmtBytes, fmtCount, fmtDateTime, fmtHumane, zoneLabel } from '../format';
import { profiles } from '../profiles';
import { viewState } from '../../state';
import { limitError, parseLimit } from '../config';
import { prettyJson } from '../recdrawer';
import { sidecarKey, type SidecarMeta } from '@redthreadlabs/tracelog-schema';

const PAGE_SIZE = 50;
const MB = 1024 * 1024;

/** "downloaded / cached locally" indicator: a down-arrow inside a circle */
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 8v6"/><path d="M9 11.5l3 3 3-3"/></svg>';

/** Dimensions the file listing can be grouped by (in display/column order). */
type RollupDim = 'interval' | 'channel' | 'host';
const ROLLUP_DIMS: RollupDim[] = ['interval', 'channel', 'host'];

interface RollupGroup {
  id: string; // stable key for expand/collapse (keyParts joined)
  keyParts: string[];
  rows: FileRow[]; // member files, in listing order (newest first)
  files: number; // all files in the group (from the listing)
  loaded: number; // files currently in memory
  records: number; // FACTUAL total records (sidecar), all files
  compressed: number; // listing size, all files (always known)
  decompressed: number; // FACTUAL decompressed bytes (sidecar), all files
  cached: number;
}

/** A row in the rendered listing: a group header, or a file (under a group, or
 *  bare in the flat list). The flattened, currently-expanded tree of these is
 *  what gets paginated. */
type DisplayItem =
  | { kind: 'header'; group: RollupGroup }
  | { kind: 'file'; row: FileRow; group: RollupGroup | null };

/** Factual per-file sizes/records from sidecars, keyed by logical S3 key. */
type FileFacts = Record<string, { decompressed?: number; records?: number }>;

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

export function renderStoreView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body store-body' });
  const tip = el('div', { className: 'chart-tooltip fixed' });
  const drawer = el('div', { className: 'drawer' }); // sidecar JSON, opened by a row tap
  container.append(body, tip, drawer);

  let available: ParsedKey[] | null = null; // null = still listing
  let cachedSet = new Set<string>();
  let listError: string | null = null;
  let page = 0;
  let openSidecar: string | null = null; // key of the file whose sidecar is shown
  const inFlight = new Set<string>();
  // Group-by: pick 0+ of interval/channel/host. None = the flat file list; any
  // selected groups the listing, with expandable headers that reveal their files.
  const groupDims = new Set<RollupDim>();
  const expanded = new Set<string>(); // ids of groups currently expanded
  let hideInactive = false; // hide files not currently loaded in memory
  // factual per-file sizes/records from sidecars (filled after the listing,
  // then the rollups become real instead of estimated)
  let facts: FileFacts = {};

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
    // hydrate sidecars → factual rollups (one-time per file; re-render when in)
    if (available && available.length) {
      storeClient
        .request<FileFacts>('fileFacts', { files: available })
        .then((f) => {
          facts = f;
          render();
        })
        .catch(() => {});
    }
  }

  async function refreshCached(): Promise<void> {
    cachedSet = await storeClient.request<Set<string>>('cacheKeys');
  }

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

  function maxPage(n: number): number {
    return Math.max(0, Math.ceil(n / PAGE_SIZE) - 1);
  }

  /**
   * Convenience memory/cache budget editor — the canonical home is the
   * workspace config, but when you land here over budget (via the indicator)
   * you can reason about it and raise the limit in place. Saving re-inits the
   * scanbar (connect), which replans + reloads at the new limit; this view
   * re-renders on the reload's data events.
   */
  function budgetPanel(): HTMLElement | null {
    const p = profiles.active();
    const ob = viewState.overBudget;
    if (!p || !ob) return null; // a convenience that surfaces only when over budget
    const recommendMb = Math.ceil(ob.estBytes / MB);
    const original = p.memoryLimitMb != null ? String(p.memoryLimitMb) : '';

    // memory-limit input with an "MB" affix inside its right edge
    const memInput = el('input', {
      attrs: { type: 'text', inputmode: 'numeric', value: original },
    }) as HTMLInputElement;
    const affix = el('div', { className: 'affix-input' }, [
      memInput,
      el('span', { className: 'affix', text: 'MB' }),
    ]);

    const updateBtn = el('button', { className: 'btn btn-primary', text: 'Update' }) as HTMLButtonElement;
    const sync = (): void => {
      // enabled only with a valid value that differs from the saved limit
      updateBtn.disabled = memInput.value.trim() === original || !!limitError(memInput.value);
    };
    const apply = (): void => {
      if (updateBtn.disabled) return;
      // canonical home is config; saving re-inits the scanbar (connect) →
      // replan + reload at the new limit; this view re-renders on the reload.
      profiles.save({ ...p, memoryLimitMb: parseLimit(memInput.value) });
    };
    memInput.addEventListener('input', sync);
    memInput.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') apply();
    });
    updateBtn.addEventListener('click', apply);
    sync(); // starts disabled (input equals the current limit)

    // the recommended limit lives inline in the prose as a link that fills the field
    const recLink = el('a', {
      className: 'budget-rec-link',
      text: fmtCount(recommendMb),
      title: `${fmtCount(recommendMb)} MB ≈ ${fmtBytes(ob.estBytes)} — enough to load the whole selection`,
      attrs: { href: '#' },
      on: {
        click: (e) => {
          e.preventDefault();
          memInput.value = String(recommendMb);
          sync();
          memInput.focus();
        },
      },
    });

    return el('div', { className: 'store-budget over' }, [
      el('h2', { className: 'store-budget-title', text: 'Over Budget' }),
      affix,
      updateBtn,
      el('p', { className: 'store-budget-note' }, [
        el('span', {
          text:
            'Your working set is bigger than your memory limit, so your results are ' +
            'truncated. Raise your memory limit to ',
        }),
        recLink,
        el('span', { text: ' to keep working, or reduce your working set.' }),
      ]),
    ]);
  }

  function render(): void {
    clear(body);
    body.append(internalsTabs('/internals/store'));
    const allRows = buildRows();

    // --- summary panel: a headline over store-ledger | kinds columns ---
    const storeCol = el('div', { className: 'sgrid' });
    const srow = (label: string, value: string) =>
      storeCol.append(
        el('div', { className: 'srow' }, [
          el('span', { className: 'label', text: label }),
          el('span', { className: 'num', text: value }),
        ]),
      );
    const loadedRows = allRows.filter((r) => r.total > 0);
    srow('records in memory', fmtCount(storeClient.snapshot.recordCount));
    srow('files in memory', `${fmtCount(loadedRows.length)} of ${fmtCount(allRows.length)}`);
    srow(
      'compressed → parsed',
      `${fmtBytes(loadedRows.reduce((s, r) => s + r.parsed.size, 0))} → ${fmtBytes(loadedRows.reduce((s, r) => s + r.sizeUncompressed, 0))}`,
    );
    const cachedFiles = allRows.filter((r) => r.cached);
    // the disk cache holds gzip bytes, so its size is the compressed total
    const cachedBytes = cachedFiles.reduce((s, r) => s + r.parsed.size, 0);
    srow('cached locally', `${fmtCount(cachedFiles.length)} (${fmtBytes(cachedBytes)})`);

    body.append(
      el('div', { className: 'store-summary' }, [
        el('p', {
          className: 'inspector-note',
          text:
            'Loading and eviction happen automatically, to optimize your memory and ' +
            'cache within the limits you set.',
        }),
        storeCol,
        el('div', { className: 'sdivider' }),
        totalKindStats(),
      ]),
    );

    // over-budget panel sits below the summary (only shown when over budget)
    const bp = budgetPanel();
    if (bp) body.append(bp);

    // --- file inventory: flat, or grouped by interval/channel/host with
    //     expandable headers. Pagination windows the flattened, expanded tree,
    //     so it's one widget at every group-by setting. ---
    // "inactive" = not currently loaded in memory; HIDING drops those rows
    const rows = hideInactive ? allRows.filter((r) => r.total > 0) : allRows;
    const dims = activeDims();
    const items = displayItems(rows);
    page = Math.min(page, maxPage(items.length));

    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Files in S3' }),
        el('span', { className: 'masthead-spacer' }),
        groupByPill(),
        inactivePill(),
      ]),
    );

    if (rows.length === 0) {
      const why =
        listError ??
        (available === null
          ? 'Listing…'
          : hideInactive && allRows.length
            ? 'No loaded files — toggle to show inactive'
            : 'The bucket is empty');
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: why }),
        ]),
      );
      return;
    }

    const table = el('table', { className: 'records txn-table store-files' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          th(dims.length ? 'group / file' : 'file', ''),
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
    const pageItems = items.slice(start, start + PAGE_SIZE);
    // contextual header: if the page opens partway through an expanded group,
    // repeat that group's header (marked "continued") so you keep your bearings
    const lead = pageItems[0];
    if (lead && lead.kind === 'file' && lead.group) {
      tbody.append(groupHeaderRow(lead.group, true));
    }
    for (const item of pageItems) {
      if (item.kind === 'header') {
        tbody.append(groupHeaderRow(item.group));
      } else {
        const tr = fileRow(item.row);
        if (item.group) tr.classList.add('nested');
        tbody.append(tr);
      }
    }
    table.append(tbody);

    // factual grand total across every file (not just this page), when grouped
    if (dims.length) {
      const t = grandTotals(rows);
      const num = (text: string, style = 'text-align:right') =>
        el('td', { className: 'num', text, attrs: { style } });
      table.append(
        el('tfoot', {}, [
          el('tr', { className: 'rollup-total' }, [
            el('td', { className: 'label', text: `all · ${fmtCount(t.files)} files` }),
            el('td', {}),
            num(t.records > 0 ? fmtCount(t.records) : '—'),
            el('td', {}),
            num(fmtBytes(t.compressed)),
            num(t.decompressed > 0 ? fmtBytes(t.decompressed) : '—'),
            num(`${fmtCount(t.cached)}/${fmtCount(t.files)}`, 'text-align:center'),
            num(t.loaded > 0 ? `${fmtCount(t.loaded)}/${fmtCount(t.files)}` : ''),
          ]),
        ]),
      );
    }
    body.append(el('div', { className: 'txn-wrap' }, [table])); // flex:1 → fills + scrolls

    // pager — windows the flattened item list; "older" pages backward in time
    const pages = maxPage(items.length) + 1;
    if (pages > 1) {
      const groupCount = items.filter((i) => i.kind === 'header').length;
      const pager = el('div', {
        className: 'pagerbar',
        attrs: { style: 'margin:0;border-radius:var(--radius-lg)' },
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
      const last = maxPage(items.length);
      pager.append(
        el('span', {
          className: 'budget',
          text: dims.length
            ? `${fmtCount(rows.length)} files · ${fmtCount(groupCount)} groups`
            : `${fmtCount(rows.length)} files`,
        }),
        el('span', { className: 'masthead-spacer' }),
        btn('⇤', 0, page === 0),
        btn('‹ newer', page - 1, page === 0),
        el('span', { className: 'budget', text: `page ${fmtCount(page + 1)} of ${fmtCount(pages)}` }),
        btn('older ›', page + 1, page >= last),
        btn('⇥', last, page >= last),
      );
      body.append(pager);
    }
  }

  /** Open the metadata sidecar for a file in the JSON drawer (tap again to close). */
  async function showSidecar(parsed: ParsedKey): Promise<void> {
    if (openSidecar === parsed.key) {
      closeSidecar();
      return;
    }
    openSidecar = parsed.key;
    paintSidecar(parsed.key, null, true); // loading
    render(); // highlight the selected row
    let meta: SidecarMeta | null = null;
    try {
      meta = await storeClient.request<SidecarMeta | null>('getSidecar', { key: parsed.key });
    } catch {
      meta = null;
    }
    if (openSidecar !== parsed.key) return; // tapped elsewhere meanwhile
    paintSidecar(parsed.key, meta, false);
  }

  function closeSidecar(): void {
    openSidecar = null;
    paintSidecar(null, null, false);
    render();
  }

  function paintSidecar(key: string | null, meta: SidecarMeta | null, loading: boolean): void {
    clear(drawer);
    if (!key) {
      drawer.classList.remove('open');
      return;
    }
    drawer.classList.add('open');
    const name = key.split('/').pop() ?? key;
    const head = el('div', { className: 'drawer-head' }, [el('h3', { text: name, title: key })]);
    if (meta) {
      head.append(
        el('button', {
          className: 'btn btn-quiet',
          text: 'copy',
          on: { click: () => void navigator.clipboard.writeText(JSON.stringify(meta, null, 2)) },
        }),
      );
    }
    head.append(el('button', { className: 'btn btn-quiet', text: '✕', on: { click: closeSidecar } }));

    const bodyEl = el('div', { className: 'drawer-body' }, [
      el('div', { className: 'drawer-meta' }, [
        el('span', { className: 'label', text: 'sidecar' }),
        el('span', { className: 'mono', text: sidecarKey(key).split('/').pop() ?? '' }),
      ]),
    ]);
    if (loading) {
      bodyEl.append(el('div', { className: 'faint', text: 'reading sidecar…', attrs: { style: 'font-size:12px;padding:4px 0' } }));
    } else if (!meta) {
      bodyEl.append(
        el('div', {
          className: 'faint',
          text: 'no metadata sidecar for this file (live snapshots and pre-sidecar files have none)',
          attrs: { style: 'font-size:12px;padding:4px 0' },
        }),
      );
    } else {
      bodyEl.append(prettyJson(meta));
    }
    drawer.append(head, bodyEl);
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

    const cls = [loaded ? '' : 'evicted-row', openSidecar === row.parsed.key ? 'selected' : '']
      .filter(Boolean)
      .join(' ');

    // cached column: the download icon when cached locally, "live" for the
    // never-cached current snapshot, else blank
    const cachedCell = el('td', {
      className: row.cached ? 'num' : 'num faint',
      title: row.cached
        ? 'cached locally in IndexedDB — loading this file is free'
        : row.parsed.current
          ? 'live snapshot — changes every upload, so it is never cached'
          : 'will be cached after its first load once finalized',
      attrs: { style: 'text-align:center' },
    });
    if (row.cached) cachedCell.innerHTML = DOWNLOAD_ICON;
    else cachedCell.textContent = row.parsed.current ? 'live' : '';
    const tr = el('tr', { className: cls }, [
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
      cachedCell,
      el('td', { attrs: { style: 'text-align:right' } }, [action]),
    ]);
    tr.addEventListener('click', () => void showSidecar(row.parsed));
    return tr;
  }

  function totalKindStats(): HTMLElement {
    const col = el('div', { className: 'sgrid' });
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

  // ----------------------------------------------------------- group-by + tree
  /** The active group-by dimensions, in display order ([] = flat list). */
  function activeDims(): RollupDim[] {
    return ROLLUP_DIMS.filter((d) => groupDims.has(d));
  }

  /** "GROUP BY: a • b • c" pill — each dimension is a link-style toggle; chosen
   *  ones are full-contrast, the rest dimmed. Choosing any turns the flat list
   *  into an expandable grouped tree. */
  function groupByPill(): HTMLElement {
    const pill = el('div', { className: 'chip groupby-pill' }, [
      el('span', { className: 'gb-label', text: 'GROUP BY:' }),
    ]);
    ROLLUP_DIMS.forEach((d, i) => {
      if (i > 0) pill.append(el('span', { className: 'gb-sep', text: '•' }));
      const opt = el('span', { className: groupDims.has(d) ? 'gb-opt on' : 'gb-opt', text: d });
      opt.addEventListener('click', () => {
        if (groupDims.has(d)) groupDims.delete(d);
        else groupDims.add(d);
        expanded.clear(); // group ids change → forget which were open
        page = 0;
        render();
      });
      pill.append(opt);
    });
    return pill;
  }

  /** Toggle pill: SHOWING / HIDING files not currently loaded in memory. */
  function inactivePill(): HTMLElement {
    return el('button', {
      className: 'chip inactive-pill',
      text: `${hideInactive ? 'HIDING' : 'SHOWING'} INACTIVE FILES`,
      title: 'inactive = not loaded in memory; toggle to show or hide them',
      on: {
        click: () => {
          hideInactive = !hideInactive;
          page = 0;
          render();
        },
      },
    });
  }

  function toggleExpand(id: string): void {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  }

  /** Flatten the grouped tree (or the flat list) into the row sequence that gets
   *  paginated: each group header, followed by its files when expanded. */
  function displayItems(rows: FileRow[]): DisplayItem[] {
    const dims = activeDims();
    if (dims.length === 0) return rows.map((row) => ({ kind: 'file', row, group: null }));
    const items: DisplayItem[] = [];
    for (const g of buildRollups(rows, dims)) {
      items.push({ kind: 'header', group: g });
      if (expanded.has(g.id)) for (const row of g.rows) items.push({ kind: 'file', row, group: g });
    }
    return items;
  }

  /** A group header row (disclosure + label + aggregate totals), spanning the
   *  same columns as file rows. `continued` marks the repeated header shown when
   *  a page begins partway through an expanded group. */
  function groupHeaderRow(g: RollupGroup, continued = false): HTMLElement {
    const open = expanded.has(g.id);
    const num = (text: string, style = 'text-align:right') =>
      el('td', { className: 'num', text, attrs: { style } });
    // action cell: evict the group's loaded files in one go (a batch diagnostic)
    const action = el('td', { attrs: { style: 'text-align:right' } });
    if (g.loaded > 0) {
      action.append(
        el('button', {
          className: 'btn btn-quiet',
          text: `evict ${fmtCount(g.loaded)}`,
          title: `drop this group's ${fmtCount(g.loaded)} loaded file${g.loaded === 1 ? '' : 's'} from memory`,
          on: {
            click: (ev) => {
              ev.stopPropagation(); // don't toggle the group open/closed
              evictGroup(g);
            },
          },
        }),
      );
    }
    const tr = el('tr', { className: 'rollup-header' }, [
      el('td', {}, [
        el('span', { className: 'disclosure', text: open ? '▾' : '▸' }),
        el('span', { className: 'mono', text: g.keyParts.join(' / ') }),
        el('span', {
          className: 'budget faint',
          text: ` · ${fmtCount(g.files)} file${g.files === 1 ? '' : 's'}${continued ? ' (continued)' : ''}`,
        }),
      ]),
      el('td', {}), // modified
      num(g.records > 0 ? fmtCount(g.records) : '—'),
      el('td', {}), // kinds
      num(fmtBytes(g.compressed)),
      num(g.decompressed > 0 ? fmtBytes(g.decompressed) : '—'),
      num(`${fmtCount(g.cached)}/${fmtCount(g.files)}`, 'text-align:center'),
      action,
    ]);
    tr.addEventListener('click', () => toggleExpand(g.id));
    return tr;
  }

  /** Drop every loaded file in a group from memory (cache untouched). */
  function evictGroup(g: RollupGroup): void {
    for (const r of g.rows) {
      if (r.total > 0) void storeClient.request('dropFile', { key: r.parsed.key });
    }
  }

  function dimValue(p: ParsedKey, d: RollupDim): string {
    return d === 'interval' ? p.interval : d === 'channel' ? p.channel : p.host;
  }

  function buildRollups(rows: FileRow[], dims: RollupDim[]): RollupGroup[] {
    const map = new Map<string, RollupGroup>();
    for (const r of rows) {
      const parts = dims.map((d) => dimValue(r.parsed, d));
      const id = JSON.stringify(parts);
      let g = map.get(id);
      if (!g) {
        g = {
          id,
          keyParts: parts,
          rows: [],
          files: 0,
          loaded: 0,
          records: 0,
          compressed: 0,
          decompressed: 0,
          cached: 0,
        };
        map.set(id, g);
      }
      g.rows.push(r);
      g.files++;
      g.compressed += r.parsed.size;
      if (r.cached) g.cached++;
      if (r.total > 0) g.loaded++;
      // factual sidecar numbers for every file; fall back to loaded values
      // (or 0) where a sidecar isn't available
      const fact = facts[r.parsed.key];
      g.records += fact?.records ?? r.total;
      g.decompressed += fact?.decompressed ?? (r.total > 0 ? r.sizeUncompressed : 0);
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

  /** Factual grand totals across every file (not just the page) for the tfoot. */
  function grandTotals(rows: FileRow[]): RollupGroup {
    const all = buildRollups(rows, []); // one group over everything
    return all[0] ?? { id: '', keyParts: [], rows: [], files: 0, loaded: 0, records: 0, compressed: 0, decompressed: 0, cached: 0 };
  }

  const onData = () => void refreshKindCounts();
  storeClient.addEventListener('data', onData);
  render();
  void refreshKindCounts();
  void loadAvailability();

  return () => {
    storeClient.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
