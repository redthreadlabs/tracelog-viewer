/**
 * The default view: a Kibana-style time-series volume chart over a sortable
 * table of transaction rollups (name · count · Σ duration). Brushing the
 * chart narrows both; clicking a transaction row opens the per-transaction
 * drill-down view.
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import { sortTxnGroups, type TxnGroup, type TxnSortKey, type BucketResult } from '../../data/aggregate';
import { renderTimebars } from '../../viz/timebars';
import { viewState } from '../../state';
import { setParams, setView, windowParam } from '../hashstate';
import { chosenBucketMs, bucketLabel } from '../bucketpicker';
import { fmtBytes, fmtCount, fmtDateTime, fmtDuration, zoneLabel } from '../format';

export function renderOverview(container: HTMLElement): () => void {
  let sortKey: TxnSortKey = 'totalDuration';
  let sortDesc = true;
  let lastGeneration = -1;
  let token = 0;
  let groups: TxnGroup[] = []; // last fetch — re-sorts don't re-query

  const chartSection = el('section', { className: 'chart-section' });
  const chartHead = el('div', { className: 'section-head' });
  const chartHost = el('div', { className: 'chart-host' });
  chartSection.append(chartHead, chartHost);

  const tableSection = el('section', { className: 'txn-section' });
  container.append(chartSection, tableSection);

  async function render(): Promise<void> {
    lastGeneration = storeClient.snapshot.generation;

    if (storeClient.snapshot.recordCount === 0) {
      renderEmpty();
      return;
    }

    const t = ++token;
    const doneRender = perf.begin('render', '/overview');
    const window = viewState.timeWindow;
    const res = await storeClient.request<{
      bucketed: BucketResult;
      groups: TxnGroup[];
      inWindow: number;
      markers: unknown;
    }>('overviewData', { window, bucketMs: chosenBucketMs() });
    if (t !== token || !container.isConnected) return;
    groups = res.groups;

    // --- chart head: window label + reset ---
    clear(chartHead);
    chartHead.append(el('span', { className: 'label', text: 'Volume' }));
    if (window) {
      chartHead.append(
        el('span', {
          className: 'budget',
          text: `${fmtDateTime(window[0])} → ${fmtDateTime(window[1])} ${zoneLabel()}`,
        }),
        el('button', {
          className: 'btn btn-quiet',
          text: '✕ full range',
          on: {
            click: () => {
              viewState.timeWindow = null;
              setParams({ w: null });
              void render();
            },
          },
        }),
      );
    } else {
      chartHead.append(
        el('span', {
          className: 'budget faint',
          text: 'drag to zoom · double-click to reset',
        }),
      );
    }
    chartHead.append(el('span', { className: 'masthead-spacer' }));

    const data = res.bucketed;
    chartHead.append(
      el('span', {
        className: 'budget faint',
        text: chosenBucketMs() === null ? `bars: auto = ${bucketLabel(data.bucketMs)}` : `bars: ${bucketLabel(data.bucketMs)}`,
      }),
      el('span', {
        className: 'budget',
        text: `${fmtCount(res.inWindow)} records`,
      }),
    );

    // --- chart ---
    renderTimebars(chartHost, data, {
      onWindow: (w) => {
        viewState.timeWindow = w;
        setParams({ w: windowParam(w) });
        void render();
      },
    });

    renderTable();
    doneRender({ records: storeClient.snapshot.recordCount });
  }

  function renderTable(): void {
    clear(tableSection);

    const sorted = sortTxnGroups(groups, sortKey, sortDesc);

    const head = el('div', { className: 'section-head' }, [
      el('span', { className: 'label', text: 'Transactions' }),
      el('span', {
        className: 'budget faint',
        text: `${fmtCount(sorted.length)} distinct names`,
      }),
    ]);
    tableSection.append(head);

    if (sorted.length === 0) {
      tableSection.append(
        el('p', {
          className: 'muted',
          text: 'No transactions in this window.',
          attrs: { style: 'padding: 8px 28px' },
        }),
      );
      return;
    }

    const maxDuration = Math.max(...sorted.map((g) => g.totalDuration), 1);

    const table = el('table', { className: 'records txn-table' });
    const thead = el('thead');
    thead.append(
      el('tr', {}, [
        sortableTh('transaction', 'name', ''),
        sortableTh('count', 'count', 'width:90px;text-align:right'),
        sortableTh('errors', 'errors', 'width:90px;text-align:right'),
        sortableTh('avg', 'avg', 'width:100px;text-align:right'),
        sortableTh('p95', 'p95', 'width:100px;text-align:right'),
        sortableTh('Σ duration', 'totalDuration', 'width:130px;text-align:right'),
        el('th', { attrs: { style: 'width:24%' } }), // duration bar gutter
      ]),
    );
    const tbody = el('tbody');
    for (const group of sorted) {
      const tr = el('tr', {}, [
        el('td', { className: 'grow', text: group.name, title: group.name }),
        el('td', {
          className: 'num',
          text: fmtCount(group.count),
          attrs: { style: 'text-align:right' },
        }),
        el('td', {
          className: 'num',
          text: group.errors > 0 ? fmtCount(group.errors) : '',
          attrs: { style: 'text-align:right;color:var(--level-error)' },
        }),
        el('td', {
          className: 'num',
          text: group.avg !== undefined ? fmtDuration(group.avg) : '',
          attrs: { style: 'text-align:right' },
        }),
        el('td', {
          className: 'num',
          text: group.p95 !== undefined ? fmtDuration(group.p95) : '',
          attrs: { style: 'text-align:right' },
        }),
        el('td', {
          className: 'num',
          text: fmtDuration(group.totalDuration),
          attrs: { style: 'text-align:right' },
        }),
        el('td', {}, [barCell(group.totalDuration / maxDuration)]),
      ]);
      tr.addEventListener('click', () => {
        setView(`/txn/${encodeURIComponent(group.name)}`);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);

    const wrap = el('div', { className: 'txn-wrap' });
    wrap.append(table);
    tableSection.append(wrap);
  }

  function sortableTh(text: string, key: TxnSortKey, style: string): HTMLElement {
    const active = sortKey === key;
    const arrow = active ? (sortDesc ? ' ▾' : ' ▴') : '';
    const th = el('th', {
      className: active ? 'label sortable on' : 'label sortable',
      text: text + arrow,
      attrs: style ? { style } : undefined,
    });
    th.addEventListener('click', () => {
      if (sortKey === key) sortDesc = !sortDesc;
      else {
        sortKey = key;
        sortDesc = key !== 'name';
      }
      renderTable();
    });
    return th;
  }

  function barCell(fraction: number): HTMLElement {
    const bar = el('div', { className: 'duration-bar' });
    const fill = el('div', { className: 'fill' });
    fill.style.width = `${Math.max(fraction * 100, 0.5)}%`;
    bar.append(fill);
    return bar;
  }

  function renderEmpty(): void {
    clear(chartHead);
    clear(chartHost);
    clear(tableSection);
    const { running, bytesDone, error } = storeClient.snapshot.progress;
    chartHost.append(
      el('div', { className: 'empty' }, [
        el('div', { className: 'fleuron', text: '❧' }),
        running
          ? el('h3', { text: `Loading… ${fmtBytes(bytesDone)}` })
          : error
            ? el('h3', { text: 'The scan hit a snag' })
            : el('h3', { text: 'Nothing scanned yet' }),
        el('p', {
          text: running
            ? 'The chart fills in as data arrives.'
            : error
              ? error
              : 'Pick a range above — it loads on its own; a large range will ask first.',
        }),
      ]),
    );
  }

  const onData = () => {
    if (storeClient.snapshot.generation !== lastGeneration) void render();
  };
  const onProgress = () => {
    if (storeClient.snapshot.recordCount === 0) renderEmpty();
  };
  storeClient.addEventListener('data', onData);
  storeClient.addEventListener('progress', onProgress);

  const onResize = () => void render();
  window.addEventListener('resize', onResize);

  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    storeClient.removeEventListener('progress', onProgress);
    window.removeEventListener('resize', onResize);
  };
}
