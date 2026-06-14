/**
 * Per-transaction drill-down (SPEC §6.2): for one transaction name —
 * summary stats (count, RPM, p50/p95/p99/max), duration histogram,
 * duration-over-time scatter, result mix, and the slowest instances, each
 * linking into its trace waterfall.
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
import { fmtCount, fmtDateTime, fmtDuration } from '../format';

const SLOWEST_N = 20;

/** what the worker returns for one transaction name (boundary-sampled) */
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

  async function render(): Promise<void> {
    const t = ++token;
    const doneRender = perf.begin('render', `/txn/${name}`);
    const stats = await storeClient.request<TxnDetail>('txnDetail', {
      name,
      window: viewState.timeWindow,
    });
    if (t !== token || !container.isConnected) return;
    renderHead();
    renderBody(stats);
    doneRender({ records: stats.count });
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

  function renderBody(stats: TxnDetail): void {
    clear(body);

    if (stats.count === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'No instances in the scanned data' }),
          el('p', { text: 'Widen the scan range, or clear the brushed time window.' }),
        ]),
      );
      return;
    }

    // --- stat cards ---
    const cards = el('div', { className: 'stat-cards' });
    const card = (label: string, value: string) =>
      cards.append(
        el('div', { className: 'stat-card' }, [
          el('div', { className: 'label', text: label }),
          el('div', { className: 'stat-value num', text: value }),
        ]),
      );
    card('requests', fmtCount(stats.count));
    if (stats.rpm !== undefined) {
      card('rate', `${stats.rpm >= 10 ? Math.round(stats.rpm) : stats.rpm.toFixed(1)}/min`);
    }
    if (stats.p50 !== undefined) card('p50', fmtDuration(stats.p50));
    if (stats.p95 !== undefined) card('p95', fmtDuration(stats.p95));
    if (stats.p99 !== undefined) card('p99', fmtDuration(stats.p99));
    if (stats.max !== undefined) card('max', fmtDuration(stats.max));

    // result mix chips
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
    body.append(el('div', { className: 'stat-row' }, [cards, mix]));

    // --- charts ---
    const chartsGrid = el('div', { className: 'charts-grid' });
    const histSection = el('div', {}, [
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Duration distribution' }),
      ]),
    ]);
    const histHost = el('div', { className: 'chart-host' });
    histSection.append(histHost);

    const sampleHost = el('span');
    const scatterSection = el('div', {}, [
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Duration over time' }),
        el('span', { className: 'budget faint', text: 'click a point to open its trace' }),
        el('span', { className: 'masthead-spacer' }),
        sampleHost,
      ]),
    ]);
    const scatterHost = el('div', { className: 'chart-host' });
    scatterSection.append(scatterHost);

    chartsGrid.append(histSection, scatterSection);
    body.append(chartsGrid);

    renderHistogram(histHost, stats.histogram, stats.ghostSpans);
    renderScatter(scatterHost, stats.instances, openTrace, sampleHost, stats.sample ?? null, stats.ghostSpans);

    // --- slowest instances --- (already capped at the worker boundary)
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

  const onData = () => void render();
  storeClient.addEventListener('data', onData);
  const onResize = () => void render();
  window.addEventListener('resize', onResize);
  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    window.removeEventListener('resize', onResize);
  };
}
