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
import type { HistBin } from '../../data/aggregate';
import type { SampleNote } from '../../worker/backend';
import { renderHistogram } from '../../viz/histogram';
import { renderScatter, resultFamily } from '../../viz/scatter';
import { viewState } from '../../state';
import { setView } from '../hashstate';
import { THEME_CHANGE_EVENT } from '../theme';
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
  histogram: HistBin[];
  estimated: true;
}

/** the records-based sections (boundary-sampled) — the deferred half of the plan */
interface TxnRecords {
  resultCounts: Map<string, number>;
  instances: Rec[];
  sample?: SampleNote;
  slowest: Rec[];
  ghostSpans: [number, number][];
  /** the full selected window — the scatter spans it whole while records stream */
  domain: [number, number];
}

/** what `solveTransaction` returns: the index summary now + the records (partial
 *  while loading) + a token the records stream back under as the load fills in */
interface TxnPlan {
  summary: TxnSummary;
  records: TxnRecords;
  token: string | null;
}

export function renderTransactionView(container: HTMLElement, name: string): () => void {
  const head = el('div', { className: 'trace-head' });
  const body = el('div', { className: 'txn-detail-body' });
  container.append(head, body);

  let token = 0; // plan solves (a range change re-solves; stale results abort)
  let built = false; // is the page structure up (summary count > 0)?
  let unsubscribe: (() => void) | null = null; // the current records subscription
  // records-section hosts, (re)set by buildStructure, populated by fillRecords
  let mixHost: HTMLElement | null = null;
  let scatterHost: HTMLElement | null = null;
  let sampleHost: HTMLElement | null = null;
  let slowestBody: HTMLElement | null = null;
  let slowestHead: HTMLElement | null = null;
  // index-served headline hosts — refreshed in place as the working set loads
  let statCardsHost: HTMLElement | null = null;
  let histHost: HTMLElement | null = null;

  // ---- solve the plan: index summary now, records streaming under a token ----
  async function rebuild(): Promise<void> {
    const t = ++token;
    unsubscribe?.(); // drop any prior records subscription
    unsubscribe = null;
    const range = viewState.timeRange;
    const plan = await storeClient.request<TxnPlan>('solveTransaction', { name, range });
    if (t !== token || !container.isConnected) return;
    if (plan.summary.count === 0) {
      built = false;
      // a cold range (no index yet) loads in the background — say so rather than
      // claim "none" while the load that will populate it is still running
      if (storeClient.snapshot.progress.running) renderLoading();
      else renderEmpty();
      return;
    }
    buildStructure(plan.summary);
    built = true;
    fillRecords(plan.records); // initial (partial while loading, complete if loaded)
    // the records stream back under the token as the load fills in
    if (plan.token) {
      unsubscribe = storeClient.subscribeDeferred<TxnRecords>(plan.token, (records, done) => {
        if (t !== token || !container.isConnected) return;
        fillRecords(records);
        if (done) {
          unsubscribe?.();
          unsubscribe = null;
        }
      });
    }
  }

  // Refresh just the index-served headline in place. The summary is index-first
  // (it renders before records load), so at the first solve the `_current`
  // interval usually isn't in the store yet and the solver builds nothing for
  // it; once its records stream in (and as live appends grow them), re-read the
  // summary and re-render the stat cards + distribution — without tearing down
  // the structure or the records subscription, so the scatter/table don't flash.
  async function refreshSummary(): Promise<void> {
    const t = token;
    const s = await storeClient.request<TxnSummary>('txnSummary', {
      name,
      range: viewState.timeRange,
    });
    if (t !== token || !container.isConnected || !built || s.count === 0) return;
    if (statCardsHost) {
      clear(statCardsHost);
      statCardsHost.append(statCards(s));
    }
    if (histHost) renderHistogram(histHost, s.histogram, []);
  }

  function buildStructure(s: TxnSummary): void {
    clear(body);

    // stat cards (latency cells italicised only when the solver marks them
    // estimated — an index sketch; an exact record read isn't) + the result mix
    mixHost = el('div', { className: 'result-mix' });
    statCardsHost = el('div', { className: 'stat-cards-host' });
    statCardsHost.append(statCards(s));
    const note = el('div', { className: 'budget faint', attrs: { style: 'margin-top:4px' } });
    if (s.estimated) note.textContent = 'p50–max estimated from the index sketch';
    body.append(
      el('div', { className: 'stat-row' }, [statCardsHost, el('div', {}, [mixHost, note])]),
    );

    // duration distribution (from the sketch, instant) + the scatter (records)
    histHost = el('div', { className: 'chart-host' });
    sampleHost = el('span');
    scatterHost = el('div', { className: 'chart-host' });
    scatterHost.append(pendingBlock(190));
    body.append(
      el('div', { className: 'charts-grid' }, [
        el('div', {}, [
          el('div', { className: 'section-head' }, [
            el('span', { className: 'label', text: 'Duration distribution' }),
            el('span', {
              className: 'budget faint',
              text: s.estimated ? 'from the index sketch' : 'from loaded records',
            }),
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

  // ---- the records sections: (re)drawn from each streamed update ----
  function fillRecords(detail: TxnRecords): void {
    if (!mixHost || !scatterHost || !slowestBody) return;
    const doneRender = perf.begin('render', `/txn/${name}`);

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
    doneRender({ records: detail.instances.length });
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
    // latency cells are marked estimated only when the SOLVER says so (index
    // sketch); an exact record read (sub-hour window) reports estimated=false
    const est = s.estimated;
    card('requests', fmtCount(s.count));
    if (s.rpm !== undefined) {
      card('rate', `${s.rpm >= 10 ? Math.round(s.rpm) : s.rpm.toFixed(1)}/min`);
    }
    if (s.p50 !== undefined) card('p50', fmtDuration(s.p50), est);
    if (s.p95 !== undefined) card('p95', fmtDuration(s.p95), est);
    if (s.p99 !== undefined) card('p99', fmtDuration(s.p99), est);
    if (s.max !== undefined) card('max', fmtDuration(s.max), est);
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

  // the records sections stream in under the plan's token, so 'data' doesn't
  // re-fetch them — but it does refresh the index-served headline in place (the
  // _current interval lands after the first solve; its count/percentiles must
  // catch up). A cold range (no index yet, summary count 0) rebuilds once its
  // index exists; a range/selection change or resize re-solves.
  const onData = () => {
    if (!built) void rebuild();
    else void refreshSummary(); // working set / live appends grew — re-read the headline
  };
  const onPlan = () => void rebuild();
  const onResize = () => void rebuild();
  // theme toggle: re-solve so the scatter + histogram re-read color tokens (the
  // result-mix dots use var(--…) inline and re-skin via the cascade for free).
  // The rebuild clears + redraws synchronously after the fast index solve, so
  // no flash; view state lives in the closure, untouched by the re-mount we skip.
  const onThemeChange = () => void rebuild();
  storeClient.addEventListener('data', onData);
  storeClient.addEventListener('plan', onPlan);
  window.addEventListener('resize', onResize);
  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
  void rebuild();

  return () => {
    token++;
    unsubscribe?.(); // tell the worker to stop producing for this gone view
    unsubscribe = null;
    storeClient.removeEventListener('data', onData);
    storeClient.removeEventListener('plan', onPlan);
    window.removeEventListener('resize', onResize);
    window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  };
}
