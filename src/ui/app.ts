/**
 * Shell: masthead, hash routing (#/records, #/config), theme & UTC toggles
 * (SPEC §5–6). The masthead carries the one indulgence — a literal red
 * thread, hand-drawn with a knot, running the width of the page.
 */
import { el, clear } from './dom';
import { initTheme, toggleTheme, currentTheme } from './theme';
import { setUtcMode, isUtcMode } from './format';
import { profiles } from './profiles';
import { renderConfig } from './config';
import { renderScanbar } from './scanbar';
import { readHash, setView, setParams, parseWindowParam, getParam } from './hashstate';
import { viewState, resetViewState } from '../state';
import { storeClient } from '../data/storeclient';
import { perf } from '../data/perf';
import type { Profile } from './profiles';
import { renderPerfView } from './views/perfview';
import { renderRecordsView } from './views/records';
import { renderEventsView } from './views/events';
import { renderMetricsView } from './views/metrics';
import { renderClientsView } from './views/clients';
import { renderScannerView } from './views/scanner';
import { renderStoreView } from './views/storeview';
import { renderOverview } from './views/overview';
import { renderTraceView } from './views/trace';
import { renderTransactionView } from './views/transaction';

const NAV: { view: string; label: string }[] = [
  { view: '/overview', label: 'Overview' },
  { view: '/events', label: 'Events' },
  { view: '/metrics', label: 'Metrics' },
  { view: '/clients', label: 'Clients' },
  { view: '/scanner', label: 'Scanner' },
  { view: '/records', label: 'Records' },
];

let teardown: (() => void) | null = null;

/** What makes one connection a different world than another. */
function profileSignature(p: Profile | null): string | null {
  return p ? `${p.bucket}|${p.region}|${p.accessKeyId}` : null;
}

export function startApp(root: HTMLElement): void {
  initTheme();

  const header = el('header');
  const scanbarHost = el('div');
  const main = el('main', {
    attrs: { style: 'flex:1;display:flex;flex-direction:column;min-height:0' },
  });
  root.append(header, scanbarHost, main);

  function renderHeader(): void {
    clear(header);
    const active = profiles.active();

    const currentView = readHash().view;
    const nav = el('nav', { className: 'masthead-nav' });
    for (const item of NAV) {
      nav.append(
        el('button', {
          className: item.view === currentView ? 'nav-link on' : 'nav-link',
          text: item.label,
          on: { click: () => setView(item.view) },
        }),
      );
    }

    const masthead = el('div', { className: 'masthead' }, [
      el('span', { className: 'masthead-title', text: 'Tracelog' }),
      el('span', { className: 'masthead-sub', text: 'Viewer' }),
      nav,
      el('span', { className: 'masthead-spacer' }),
      el('div', { className: 'masthead-controls' }, [
        active
          ? el('button', {
              className: 'chip',
              title: `s3://${active.bucket} · ${active.region}`,
              text: active.name,
              on: { click: () => setView('/config') },
            })
          : el('button', {
              className: 'chip',
              text: 'connect…',
              on: { click: () => setView('/config') },
            }),
        el('button', {
          className: isUtcMode() ? 'toggle on' : 'toggle',
          text: 'UTC',
          title: 'toggle UTC / local time display',
          on: {
            click: (ev) => {
              setUtcMode(!isUtcMode());
              (ev.currentTarget as HTMLElement).classList.toggle('on', isUtcMode());
              route(); // re-render the active view with the new zone
            },
          },
        }),
        el('button', {
          className: 'toggle',
          text: currentTheme() === 'dark' ? '☀' : '☾',
          title: 'toggle light / dark',
          on: {
            click: (ev) => {
              toggleTheme();
              (ev.currentTarget as HTMLElement).textContent =
                currentTheme() === 'dark' ? '☀' : '☾';
              route(); // charts re-read color tokens on render
            },
          },
        }),
      ]),
    ]);

    header.append(masthead, threadRule());
  }

  function renderScanbarIfConnected(): void {
    clear(scanbarHost);
    if (profiles.active()) renderScanbar(scanbarHost);
  }

  // Seeded at boot so the initial connect() of a remembered profile does NOT
  // count as a switch (a shared URL's w=/ch= params must survive page load).
  let connectedSignature = profileSignature(profiles.active());

  function connect(): void {
    const active = profiles.active();
    const signature = profileSignature(active);
    if (signature !== connectedSignature) {
      // A different bucket/key is a different world: the worker keeps a
      // separate session (store) per profile, so switching is joining the
      // other session — tab-side view state and stale params still reset.
      connectedSignature = signature;
      resetViewState();
      setParams({ ch: null, w: null });
    }
    if (active) {
      void storeClient.attach(active).then(() => {
        renderHeader();
        renderScanbarIfConnected();
      });
    }
    renderHeader();
    renderScanbarIfConnected();
  }


  function route(): void {
    teardown?.();
    teardown = null;
    clear(main);
    renderHeader(); // keep nav active-state in sync

    const view = readHash().view;
    if (!profiles.active() || view === '/config') {
      renderConfig(main, () => {
        connect();
        setView('/overview');
      });
      return;
    }
    // Time every view render against the store size at that moment — the
    // perf page itself excluded, or logging its render would re-render it.
    const doneRender = view === '/internals/perf' ? null : perf.begin('render', view);
    teardown = renderView(view);
    doneRender?.({ records: storeClient.snapshot.recordCount });
  }

  function renderView(view: string): (() => void) | null {
    if (view === '/records') return renderRecordsView(main);
    if (view === '/events') return renderEventsView(main);
    if (view === '/metrics') return renderMetricsView(main);
    if (view === '/clients') return renderClientsView(main);
    if (view === '/scanner') return renderScannerView(main);
    // viewer-internals family (#/internals/…): about the app, not the logs
    if (view === '/internals/store') return renderStoreView(main);
    if (view === '/internals/perf') return renderPerfView(main);
    if (view.startsWith('/trace/')) {
      return renderTraceView(main, view.slice('/trace/'.length));
    }
    if (view.startsWith('/txn/')) {
      return renderTransactionView(main, decodeURIComponent(view.slice('/txn/'.length)));
    }
    // default: overview
    return renderOverview(main);
  }

  profiles.addEventListener('change', () => {
    connect();
  });

  window.addEventListener('hashchange', route);

  // restore a shared time window (`w=t0-t1`) on boot
  viewState.timeWindow = parseWindowParam(getParam('w'));

  connect();
  route();
}

/** The red thread: slight waves, one small loop — drawn once, full width. */
function threadRule(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'thread-rule');
  svg.setAttribute('viewBox', '0 0 1200 14');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '14');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M -4 8 C 120 5, 240 11, 360 8 S 580 4, 700 8 c 14 1, 22 -7, 34 -6 c 10 1, 8 12, -2 11 c -8 -1, -6 -9, 4 -10 C 820 2, 980 12, 1204 7',
  );
  svg.append(path);
  return svg;
}
