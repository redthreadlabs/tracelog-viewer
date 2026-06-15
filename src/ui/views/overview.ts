/**
 * The default view: a Kibana-style time-series volume chart over a sortable
 * table of transaction rollups (name · count · Σ duration). Brushing the
 * chart narrows both; clicking a transaction row opens the per-transaction
 * drill-down view.
 */
import { el, clear, pendingBlock } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import { sortTxnGroups, type TxnGroup, type TxnSortKey, type SeriesResult } from '../../data/aggregate';
import { renderSeriesbars } from '../../viz/seriesbars';
import { viewState } from '../../state';
import { pushParams, setView, RANGE_NAV_EVENT } from '../hashstate';
import { chosenBucketMs, bucketLabel } from '../bucketpicker';
import type { Metric } from '../query';
import { fmtBytes, fmtCount, fmtDuration, isUtcMode } from '../format';

export function renderOverview(container: HTMLElement): () => void {
  let sortKey: TxnSortKey = 'totalDuration';
  let sortDesc = true;
  let lastGeneration = -1;
  let token = 0;
  let groups: TxnGroup[] = []; // last fetch — re-sorts don't re-query
  let chartShown = false; // true once a chart is rendered
  let lastComplete = false; // whether the last answer fully covered the range (no ghost)
  // The transactions the chart displays, each as its own colored band (no
  // "Other"). null = default to the worker's top-N; the first toggle materializes
  // it into an explicit, editable selection. PALETTE caps how many show at once
  // (one --series-* color each).
  const PALETTE = 8;
  let selection: string[] | null = null;
  let displayed = new Set<string>(); // names drawn by the last response
  // a stable color slot (0..PALETTE-1) per transaction, so toggling one never
  // recolors the others: in default mode it tracks the top-N by rank, in explicit
  // mode it persists (freed on removal)
  const slot = new Map<string, number>();
  const colorForSlot = (name: string, styles: CSSStyleDeclaration): string => {
    const i = slot.get(name);
    return i === undefined
      ? styles.getPropertyValue('--ink-faint').trim() // not shown → grey
      : styles.getPropertyValue(`--series-${(i % PALETTE) + 1}`).trim();
  };
  const assignSlots = (names: string[]): void => {
    for (const name of names) {
      if (slot.has(name)) continue;
      const used = new Set(slot.values());
      let i = 0;
      while (used.has(i)) i++; // lowest free slot
      slot.set(name, i);
    }
  };
  // add/remove a transaction from the chart. The first toggle freezes the
  // current top-N into an explicit selection; thereafter the chart shows exactly
  // the selection (no auto re-ranking pulling others in).
  function toggle(name: string): void {
    if (selection === null) selection = [...displayed];
    const i = selection.indexOf(name);
    if (i !== -1) {
      selection.splice(i, 1);
      slot.delete(name); // free the color
    } else if (selection.length < PALETTE) {
      selection.push(name);
      assignSlots([name]);
    } else {
      return; // palette full — remove one before adding another
    }
    void render();
  }

  const chartSection = el('section', { className: 'chart-section' });
  const chartHead = el('div', { className: 'section-head' });
  const chartHost = el('div', { className: 'chart-host' });
  chartSection.append(chartHead, chartHost);

  const tableSection = el('section', { className: 'txn-section' });
  container.append(chartSection, tableSection);

  // corner spinners shown while each widget is still populating: the chart's
  // only while its answer is still incomplete (ghost present) and loading,
  // the table's whenever a scan is feeding it
  const chartSpin = el('div', { className: 'corner-spinner' });
  const tableSpin = el('div', { className: 'corner-spinner' });
  chartSpin.style.display = 'none';
  tableSpin.style.display = 'none';
  function updateSpinners(): void {
    const running = storeClient.snapshot.progress.running;
    if (!chartSpin.isConnected) chartSection.append(chartSpin);
    if (!tableSpin.isConnected) tableSection.append(tableSpin);
    // show the chart spinner only while the answer is still incomplete (ghost
    // present) and loading — a complete answer needs no spinner even if a
    // background prefetch keeps running
    chartSpin.style.display = chartShown && running && !lastComplete ? 'block' : 'none';
    tableSpin.style.display = chartShown && running ? 'block' : 'none';
  }

  // the page's bones render before any data arrives (worker round trip)
  chartHead.append(el('span', { className: 'label', text: 'Volume' }));
  chartHost.append(pendingBlock(190));
  tableSection.append(
    el('div', { className: 'section-head' }, [
      el('span', { className: 'label', text: 'Transactions' }),
    ]),
  );

  async function render(): Promise<void> {
    lastGeneration = storeClient.snapshot.generation;

    const t = ++token;
    const doneRender = perf.begin('render', '/overview');
    const range = viewState.timeRange;
    // the chart declares the metric it wants; the worker's solver (SPEC §11)
    // decides how to satisfy it. Σ duration broken out by transaction.
    const metric: Metric = { op: 'sum', field: 'duration', groupBy: 'transaction' };
    const res = await storeClient.request<{
      series: SeriesResult;
      ghostSpans: [number, number][];
      complete: boolean;
      groups: TxnGroup[];
    }>('overviewData', {
      range,
      bucketMs: chosenBucketMs(),
      utc: isUtcMode(),
      metric,
      // explicit legend selection, or undefined to let the worker pick the top-N
      show: selection === null ? undefined : selection,
    });
    if (t !== token || !container.isConnected) return;
    groups = res.groups;
    displayed = new Set(res.series.series);
    if (selection === null) {
      // default mode: color slots track the current top-N by rank
      slot.clear();
      res.series.series.forEach((name, i) => slot.set(name, i));
    } else {
      assignSlots(res.series.series);
    }

    // Empty/loading state only when there are NO transactions at all (renderEmpty
    // distinguishes "still loading" from "nothing here" via progress). If
    // transactions exist but the chart series is empty — e.g. all toggled out —
    // still render, so the table stays up and they can be re-enabled.
    if (res.groups.length === 0) {
      chartShown = false;
      renderEmpty();
      updateSpinners();
      return;
    }
    chartShown = true;
    lastComplete = res.complete;

    // --- chart head ---
    clear(chartHead);
    chartHead.append(el('span', { className: 'label', text: 'Time by transaction' }));
    if (!range) {
      chartHead.append(
        el('span', {
          className: 'budget faint',
          text: 'drag to set the time range',
        }),
      );
    }
    chartHead.append(el('span', { className: 'masthead-spacer' }));

    const data = res.series;
    // total from the buckets themselves, so the label always matches what's
    // actually drawn (the tally need not equal the records currently in the store)
    const total = data.buckets.reduce((s, b) => s + b.total, 0);
    chartHead.append(
      el('span', {
        className: 'budget faint',
        text: chosenBucketMs() === null ? `bars: auto = ${bucketLabel(data.bucketMs)}` : `bars: ${bucketLabel(data.bucketMs)}`,
      }),
      el('span', {
        className: 'budget',
        text: `${fmtDuration(total)} total`,
      }),
    );

    // --- chart ---
    renderSeriesbars(
      chartHost,
      data,
      {
        colorOf: (name, _i, styles) => colorForSlot(name, styles),
        formatValue: fmtDuration,
        onRange: (w) => {
          if (!w) return;
          // dragging sets the time range (from/to): push a history entry (so Back
          // returns to the previous range) and let the scanbar adopt it + reload
          viewState.timeRange = w; // optimistic, so the chart doesn't flash the old range
          pushParams({ from: String(Math.round(w[0])), to: String(Math.round(w[1])) });
          globalThis.dispatchEvent(new Event(RANGE_NAV_EVENT));
        },
      },
      res.ghostSpans,
    );

    renderTable();
    updateSpinners();
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
    const chartStyles = getComputedStyle(chartHost);
    const atCap = selection !== null && selection.length >= PALETTE;

    const table = el('table', { className: 'records txn-table' });
    const thead = el('thead');
    thead.append(
      el('tr', {}, [
        el('th', { attrs: { style: 'width:30px' } }), // the chart-toggle swatch
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
      const shown = displayed.has(group.name);
      // a shown row can always be hidden; a hidden row can be shown unless the
      // palette is full (then it's disabled until one is freed)
      const disabled = !shown && atCap;
      const title = shown ? 'hide from chart' : disabled ? 'chart is full (8 max)' : 'show in chart';
      const toggleBtn = el('button', {
        className: `txn-toggle${shown ? ' on' : ''}${disabled ? ' disabled' : ''}`,
        attrs: {
          title,
          'aria-label': title,
          ...(shown ? { style: `background:${colorForSlot(group.name, chartStyles)}` } : {}),
        },
      });
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't open the drill-down
        toggle(group.name);
      });
      const tr = el('tr', {}, [
        el('td', { className: 'toggle-cell' }, [toggleBtn]),
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
  // the scanbar fires 'plan' once the selection's files are known — re-query so
  // the chart can render as soon as the worker can satisfy it (often before, or
  // without, any records being loaded)
  const onPlan = () => void render();
  const onProgress = () => {
    // don't wipe a shown chart while records trickle in; only the genuinely
    // empty pre-chart state tracks loading progress
    if (!chartShown) renderEmpty();
    updateSpinners();
  };
  storeClient.addEventListener('data', onData);
  storeClient.addEventListener('plan', onPlan);
  storeClient.addEventListener('progress', onProgress);

  const onResize = () => void render();
  window.addEventListener('resize', onResize);

  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    storeClient.removeEventListener('plan', onPlan);
    storeClient.removeEventListener('progress', onProgress);
    window.removeEventListener('resize', onResize);
  };
}
