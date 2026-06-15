/**
 * Per-transaction drill-down (SPEC §6.2, §11). Two phases, fastest-plan:
 *  1. an INSTANT summary served entirely from the durable indexes — count, rate,
 *     p50/p95/p99/max (estimated from the duration sketch) and the duration
 *     distribution — shown before any records load;
 *  2. the records-based detail (duration-over-time scatter, result mix, slowest
 *     instances, and exact percentiles), which fills in once the working-set load
 *     this view triggers completes — those need raw instances.
 */
import { el, clear, pendingBlock } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import type { HistBucket } from '../../data/aggregate';
import type { SampleNote } from '../../worker/backend';
import { renderHistogram } from '../../viz/histogram';
import { renderScatter, resultFamily } from '../../viz/scatter';
import { viewState } from '../../state';
import { setView } from '../hashstate';
import type { Rec } from '../../data/types';
import { fmtBytes, fmtCount, fmtDateTime, fmtDuration } from '../format';

const SLOWEST_N = 20;

/** index-served headline for one transaction (no records needed) */
interface TxnSummary {
  name: string;
  count: number;
  errors: number;
  avg?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  rpm?: number;
  histogram: HistBucket[];
  estimated: true;
}

/** records-based detail for one transaction name (boundary-sampled) */
interface TxnDetail {
  name: string;
  count: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  rpm?: number;
  resultCounts: Map<string, number>;
  histogram: HistBucket[];
  instances: Rec[];
  sample?: SampleNote;
  slowest: Rec[];
  ghostSpans: [number, number][];
}

export function renderTransactionView(container: HTMLElement, name: string): () => void {
  const head = el('div', { className: 'trace-head' });
  const body = el('div', { className: 'txn-detail-body' });
  container.append(head, body);
  let token = 0;
  let phase: 'pending' | 'empty' | 'summary' | 'full' = 'pending';
  let placeholder: HTMLElement | null = null;

  async function render(): Promise<void> {
    const t = ++token;
    const range = viewState.timeRange;
    // (1) the index summary — instant, complete, estimated
    const summary = await storeClient.request<TxnSummary>('txnSummary', { name, range });
    if (t !== token || !container.isConnected) return;
    if (summary.count === 0) {
      renderEmpty();
      phase = 'empty';
      return;
    }
    // (2) the records detail — only once the working set is loaded; partial
    // records would be a misleading scatter / wrong percentiles
    if (!storeClient.snapshot.progress.running) {
      const doneRender = perf.begin('render', `/txn/${name}`);
      const detail = await storeClient.request<TxnDetail>('txnDetail', { name, range });
      if (t !== token || !container.isConnected) return;
      if (detail.count > 0) {
        renderFull(detail);
        phase = 'full';
        doneRender({ records: detail.count });
        return;
      }
    }
    renderSummary(summary);
    phase = 'summary';
  }

  function renderHead(): void {
    clear(head);
    head.append(
      el('button', {
        className: 'btn btn-quiet',
        text: '← back',
        on: { click: () => history.back() },
      }),
      el('h2', { className: 'trace-title', text: name }),
      el('span', { className: 'masthead-spacer' }),
      el('button', {
        className: 'btn btn-quiet',
        text: 'view in records →',
        on: {
          click: () => {
            viewState.pendingRecordsSearch = name;
            setView('/records');
          },
        },
      }),
    );
  }

  function renderEmpty(): void {
    clear(body);
    body.append(
      el('div', { className: 'empty' }, [
        el('div', { className: 'fleuron', text: '❧' }),
        el('h3', { text: 'No instances in the scanned data' }),
        el('p', { text: 'Widen the scan range, or clear the brushed time window.' }),
      ]),
    );
  }

  /** stat cards shared by both phases; `estimated` italicises the latency cells
   *  (count/rate are exact from the cube either way). */
  function statCards(
    stats: { count: number; rpm?: number; p50?: number; p95?: number; p99?: number; max?: number },
    estimated: boolean,
  ): HTMLElement {
    const cards = el('div', { className: 'stat-cards' });
    const card = (label: string, value: string, est = false): void => {
      cards.append(
        el('div', { className: 'stat-card' }, [
          el('div', { className: 'label', text: label }),
          el('div', { className: est ? 'stat-value num est-cell' : 'stat-value num', text: value }),
        ]),
      );
    };
    card('requests', fmtCount(stats.count));
    if (stats.rpm !== undefined) {
      card('rate', `${stats.rpm >= 10 ? Math.round(stats.rpm) : stats.rpm.toFixed(1)}/min`);
    }
    if (stats.p50 !== undefined) card('p50', fmtDuration(stats.p50), estimated);
    if (stats.p95 !== undefined) card('p95', fmtDuration(stats.p95), estimated);
    if (stats.p99 !== undefined) card('p99', fmtDuration(stats.p99), estimated);
    if (stats.max !== undefined) card('max', fmtDuration(stats.max), estimated);
    return cards;
  }

  // ---- phase 1: index-served summary ----
  function renderSummary(s: TxnSummary): void {
    clear(body);
    const note = el('span', {
      className: 'budget faint',
      text: 'estimated from the index — exact values load with the instances',
    });
    body.append(el('div', { className: 'stat-row' }, [statCards(s, true), note]));

    const histHost = el('div', { className: 'chart-host' });
    body.append(
      el('div', {}, [
        el('div', { className: 'section-head' }, [
          el('span', { className: 'label', text: 'Duration distribution' }),
          el('span', { className: 'budget faint', text: 'from the duration sketch' }),
        ]),
        histHost,
      ]),
    );
    renderHistogram(histHost, s.histogram, []);

    // the records-based sections are still loading (this view triggered the load)
    placeholder = el('div', { className: 'empty', attrs: { style: 'padding:32px' } }, [
      el('div', { className: 'fleuron', text: '❧' }),
      el('h3', { text: 'Loading instances…' }),
      el('p', { className: 'muted', text: placeholderProgressText() }),
      el('p', {
        className: 'muted',
        text: 'the duration-over-time scatter, result mix, and slowest instances need the raw records',
      }),
    ]);
    body.append(placeholder);
  }

  function placeholderProgressText(): string {
    const p = storeClient.snapshot.progress;
    if (!p.running) return 'preparing…';
    const done = fmtBytes(p.bytesUncompressedDone);
    const total = p.bytesUncompressedTotal > 0 ? ` of ${fmtBytes(p.bytesUncompressedTotal)}` : '';
    return `loading the working set — ${done}${total} in memory`;
  }

  function updatePlaceholder(): void {
    if (!placeholder) return;
    const line = placeholder.querySelector('p.muted');
    if (line) line.textContent = placeholderProgressText();
  }

  // ---- phase 2: records-based detail ----
  function renderFull(stats: TxnDetail): void {
    clear(body);
    placeholder = null;

    const mix = el('div', { className: 'result-mix' });
    const families: Record<string, string> = {
      ok: 'var(--kind-span)',
      warn: 'var(--level-warn)',
      bad: 'var(--thread)',
      other: 'var(--ink-faint)',
    };
    for (const [result, count] of [...stats.resultCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const sample = stats.instances.find((r) => (r.result ?? r.outcome ?? 'unknown') === result);
      const family = sample ? resultFamily(sample) : 'other';
      mix.append(
        el('span', { className: 'chip', attrs: { style: 'cursor:default' } }, [
          el('span', { className: 'dot', attrs: { style: `background: ${families[family]}` } }),
          el('span', { text: result }),
          el('span', { className: 'count', text: fmtCount(count) }),
        ]),
      );
    }
    body.append(el('div', { className: 'stat-row' }, [statCards(stats, false), mix]));

    const chartsGrid = el('div', { className: 'charts-grid' });
    const histHost = el('div', { className: 'chart-host' });
    const histSection = el('div', {}, [
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Duration distribution' }),
      ]),
      histHost,
    ]);

    const sampleHost = el('span');
    const scatterHost = el('div', { className: 'chart-host' });
    const scatterSection = el('div', {}, [
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Duration over time' }),
        el('span', { className: 'budget faint', text: 'click a point to open its trace' }),
        el('span', { className: 'masthead-spacer' }),
        sampleHost,
      ]),
      scatterHost,
    ]);

    chartsGrid.append(histSection, scatterSection);
    body.append(chartsGrid);

    renderHistogram(histHost, stats.histogram, stats.ghostSpans);
    renderScatter(scatterHost, stats.instances, openTrace, sampleHost, stats.sample ?? null, stats.ghostSpans);

    const slowest = stats.slowest;
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: `Slowest ${Math.min(SLOWEST_N, slowest.length)}` }),
        el('span', { className: 'budget faint', text: 'click to open the trace waterfall' }),
      ]),
    );

    const table = el('table', { className: 'records txn-table' });
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { className: 'label', text: 'time', attrs: { style: 'width:200px' } }),
          el('th', {
            className: 'label',
            text: 'duration',
            attrs: { style: 'width:110px;text-align:right' },
          }),
          el('th', { className: 'label', text: 'result', attrs: { style: 'width:120px' } }),
          el('th', { className: 'label', text: 'user', attrs: { style: 'width:160px' } }),
          el('th', { className: 'label', text: 'trace' }),
        ]),
      ]),
    );
    const tbody = el('tbody');
    for (const rec of slowest) {
      const tr = el('tr', {}, [
        el('td', { className: 'num', text: fmtDateTime(rec.ts) }),
        el('td', {
          className: 'num',
          text: fmtDuration(rec.duration!),
          attrs: { style: 'text-align:right' },
        }),
        el('td', { className: 'muted', text: rec.result ?? rec.outcome ?? '' }),
        el('td', { className: 'mono faint', text: rec.userId ?? '' }),
        el('td', { className: 'mono faint', text: rec.traceId ? `${rec.traceId.slice(0, 12)}…` : '' }),
      ]);
      tr.addEventListener('click', () => openTrace(rec));
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [table]));
  }

  function openTrace(rec: Rec): void {
    if (rec.traceId) setView(`/trace/${rec.traceId}`);
  }

  // header renders immediately — the name is in the URL, not the data
  renderHead();
  body.append(pendingBlock(220));

  // While loading, only nudge the placeholder; transition to the full detail when
  // the load completes (running flips false). A new record batch with the load
  // already done, or a range change, re-evaluates the phase.
  const onData = () => {
    if (!storeClient.snapshot.progress.running) void render();
  };
  const onProgress = () => {
    if (phase === 'summary' && storeClient.snapshot.progress.running) updatePlaceholder();
    else if (phase !== 'full' && !storeClient.snapshot.progress.running) void render();
  };
  const onPlan = () => {
    phase = 'pending';
    void render();
  };
  const onResize = () => void render();
  storeClient.addEventListener('data', onData);
  storeClient.addEventListener('progress', onProgress);
  storeClient.addEventListener('plan', onPlan);
  window.addEventListener('resize', onResize);
  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    storeClient.removeEventListener('progress', onProgress);
    storeClient.removeEventListener('plan', onPlan);
    window.removeEventListener('resize', onResize);
  };
}
