/**
 * Per-transaction drill-down (SPEC §6.2, §11). Fastest-plan, two-source:
 *  - the summary — count, rate, p50/p95/p99/max (estimated from the duration
 *    sketch) and the duration distribution — renders INSTANTLY from the durable
 *    indexes, before any records load;
 *  - the records-based sections (result mix, duration-over-time scatter, slowest
 *    instances) are scaffolded immediately and FILL IN as the working-set load
 *    this view triggers streams records in — they need raw instances.
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
  resultCounts: Map<string, number>;
  instances: Rec[];
  sample?: SampleNote;
  slowest: Rec[];
  ghostSpans: [number, number][];
  /** the full selected window — the scatter spans it whole while records stream */
  domain: [number, number];
}

export function renderTransactionView(container: HTMLElement, name: string): () => void {
  const head = el('div', { className: 'trace-head' });
  const body = el('div', { className: 'txn-detail-body' });
  container.append(head, body);

  let token = 0; // structure builds (a range change rebuilds, fills abort)
  let fillToken = 0; // records fills (only the latest applies)
  let built = false; // is the page structure up (summary count > 0)?
  // records-section hosts, (re)set by buildStructure, populated by fillRecords
  let mixHost: HTMLElement | null = null;
  let scatterHost: HTMLElement | null = null;
  let sampleHost: HTMLElement | null = null;
  let slowestBody: HTMLElement | null = null;
  let slowestHead: HTMLElement | null = null;

  // ---- the index summary: instant page skeleton ----
  async function rebuild(): Promise<void> {
    const t = ++token;
    const range = viewState.timeRange;
    const summary = await storeClient.request<TxnSummary>('txnSummary', { name, range });
    if (t !== token || !container.isConnected) return;
    if (summary.count === 0) {
      built = false;
      // a cold range (no index yet) loads in the background — say so rather than
      // claim "none" while the load that will populate it is still running
      if (storeClient.snapshot.progress.running) renderLoading();
      else renderEmpty();
      return;
    }
    buildStructure(summary);
    built = true;
    void fillRecords();
  }

  function buildStructure(s: TxnSummary): void {
    clear(body);

    // stat cards (latency cells italicised — they're index estimates) + the
    // result mix, which fills from records
    mixHost = el('div', { className: 'result-mix' });
    body.append(
      el('div', { className: 'stat-row' }, [
        statCards(s),
        el('div', {}, [
          mixHost,
          el('div', {
            className: 'budget faint',
            attrs: { style: 'margin-top:4px' },
            text: 'p50–max estimated from the index sketch',
          }),
        ]),
      ]),
    );

    // duration distribution (from the sketch, instant) + the scatter (records)
    const histHost = el('div', { className: 'chart-host' });
    sampleHost = el('span');
    scatterHost = el('div', { className: 'chart-host' });
    scatterHost.append(pendingBlock(190));
    body.append(
      el('div', { className: 'charts-grid' }, [
        el('div', {}, [
          el('div', { className: 'section-head' }, [
            el('span', { className: 'label', text: 'Duration distribution' }),
            el('span', { className: 'budget faint', text: 'from the index sketch' }),
          ]),
          histHost,
        ]),
        el('div', {}, [
          el('div', { className: 'section-head' }, [
            el('span', { className: 'label', text: 'Duration over time' }),
            el('span', { className: 'budget faint', text: 'click a point to open its trace' }),
            el('span', { className: 'masthead-spacer' }),
            sampleHost,
          ]),
          scatterHost,
        ]),
      ]),
    );
    renderHistogram(histHost, s.histogram, []);

    // slowest instances — header + a table that fills from records
    slowestHead = el('span', { className: 'label', text: 'Slowest' });
    body.append(
      el('div', { className: 'section-head' }, [
        slowestHead,
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
    slowestBody = el('tbody');
    slowestBody.append(loadingRow());
    table.append(slowestBody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [table]));
  }

  // ---- the records sections: progressive fill as the load streams in ----
  async function fillRecords(): Promise<void> {
    const ft = ++fillToken;
    const structureToken = token;
    const doneRender = perf.begin('render', `/txn/${name}`);
    const detail = await storeClient.request<TxnDetail>('txnDetail', {
      name,
      range: viewState.timeRange,
    });
    if (ft !== fillToken || structureToken !== token || !container.isConnected) return;
    if (!mixHost || !scatterHost || !slowestBody) return;

    // result mix
    clear(mixHost);
    const families: Record<string, string> = {
      ok: 'var(--kind-span)',
      warn: 'var(--level-warn)',
      bad: 'var(--thread)',
      other: 'var(--ink-faint)',
    };
    for (const [result, count] of [...detail.resultCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const sample = detail.instances.find((r) => (r.result ?? r.outcome ?? 'unknown') === result);
      const family = sample ? resultFamily(sample) : 'other';
      mixHost.append(
        el('span', { className: 'chip', attrs: { style: 'cursor:default' } }, [
          el('span', { className: 'dot', attrs: { style: `background: ${families[family]}` } }),
          el('span', { text: result }),
          el('span', { className: 'count', text: fmtCount(count) }),
        ]),
      );
    }

    // duration-over-time scatter
    renderScatter(
      scatterHost,
      detail.instances,
      openTrace,
      sampleHost!,
      detail.sample ?? null,
      detail.ghostSpans,
      detail.domain,
    );

    // slowest instances
    if (slowestHead) {
      slowestHead.textContent = `Slowest ${Math.min(SLOWEST_N, detail.slowest.length)}`;
    }
    clear(slowestBody);
    if (detail.slowest.length === 0) {
      slowestBody.append(loadingRow());
    } else {
      for (const rec of detail.slowest) {
        const tr = el('tr', {}, [
          el('td', { className: 'num', text: fmtDateTime(rec.ts) }),
          el('td', {
            className: 'num',
            text: fmtDuration(rec.duration!),
            attrs: { style: 'text-align:right' },
          }),
          el('td', { className: 'muted', text: rec.result ?? rec.outcome ?? '' }),
          el('td', { className: 'mono faint', text: rec.userId ?? '' }),
          el('td', {
            className: 'mono faint',
            text: rec.traceId ? `${rec.traceId.slice(0, 12)}…` : '',
          }),
        ]);
        tr.addEventListener('click', () => openTrace(rec));
        slowestBody.append(tr);
      }
    }
    doneRender({ records: detail.count });
  }

  function loadingRow(): HTMLElement {
    const p = storeClient.snapshot.progress;
    const text = p.running ? 'loading instances…' : 'no instances loaded for this window';
    return el('tr', {}, [el('td', { className: 'muted', attrs: { colspan: '5' }, text })]);
  }

  function statCards(s: TxnSummary): HTMLElement {
    const cards = el('div', { className: 'stat-cards' });
    const card = (label: string, value: string, est = false): void => {
      cards.append(
        el('div', { className: 'stat-card' }, [
          el('div', { className: 'label', text: label }),
          el('div', { className: est ? 'stat-value num est-cell' : 'stat-value num', text: value }),
        ]),
      );
    };
    card('requests', fmtCount(s.count));
    if (s.rpm !== undefined) {
      card('rate', `${s.rpm >= 10 ? Math.round(s.rpm) : s.rpm.toFixed(1)}/min`);
    }
    if (s.p50 !== undefined) card('p50', fmtDuration(s.p50), true);
    if (s.p95 !== undefined) card('p95', fmtDuration(s.p95), true);
    if (s.p99 !== undefined) card('p99', fmtDuration(s.p99), true);
    if (s.max !== undefined) card('max', fmtDuration(s.max), true);
    return cards;
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

  function renderLoading(): void {
    clear(body);
    body.append(
      el('div', { className: 'empty' }, [
        el('div', { className: 'fleuron', text: '❧' }),
        el('h3', { text: 'Loading…' }),
      ]),
    );
  }

  function openTrace(rec: Rec): void {
    if (rec.traceId) setView(`/trace/${rec.traceId}`);
  }

  // header renders immediately — the name is in the URL, not the data
  renderHead();
  body.append(pendingBlock(220));

  // records stream in → refill the records sections; a not-yet-built structure
  // (cold range) rebuilds once its index exists; a range change rebuilds.
  const onData = () => (built ? void fillRecords() : void rebuild());
  const onPlan = () => void rebuild();
  const onResize = () => void rebuild();
  storeClient.addEventListener('data', onData);
  storeClient.addEventListener('plan', onPlan);
  window.addEventListener('resize', onResize);
  void rebuild();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    storeClient.removeEventListener('plan', onPlan);
    window.removeEventListener('resize', onResize);
  };
}
