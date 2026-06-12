/**
 * Shell: masthead, hash routing (#/records, #/config), theme & UTC toggles
 * (SPEC §5–6). The masthead carries the one indulgence — a literal red
 * thread, hand-drawn with a knot, running the width of the page.
 */
import { el, clear } from './dom';
import { initTheme, toggleTheme, currentTheme } from './theme';
import { setUtcMode, isUtcMode } from './format';
import { profiles } from './profiles';
import { LogBucket } from '../s3/client';
import { renderConfig } from './config';
import { renderScanbar } from './scanbar';
import { readHash, setView, parseWindowParam, getParam } from './hashstate';
import { viewState } from '../state';
import { renderRecordsView } from './views/records';
import { renderEventsView } from './views/events';
import { renderMetricsView } from './views/metrics';
import { renderClientsView } from './views/clients';
import { renderScannerView } from './views/scanner';
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
let bucket: LogBucket | null = null;

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
    if (bucket) renderScanbar(scanbarHost, bucket);
  }

  function connect(): void {
    const active = profiles.active();
    bucket = active ? new LogBucket(active) : null;
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
    if (view === '/records') {
      teardown = renderRecordsView(main);
      return;
    }
    if (view === '/events') {
      teardown = renderEventsView(main);
      return;
    }
    if (view === '/metrics') {
      teardown = renderMetricsView(main);
      return;
    }
    if (view === '/clients') {
      teardown = renderClientsView(main);
      return;
    }
    if (view === '/scanner') {
      teardown = renderScannerView(main);
      return;
    }
    if (view.startsWith('/trace/')) {
      teardown = renderTraceView(main, view.slice('/trace/'.length));
      return;
    }
    if (view.startsWith('/txn/')) {
      teardown = renderTransactionView(main, decodeURIComponent(view.slice('/txn/'.length)));
      return;
    }
    // default: overview
    teardown = renderOverview(main);
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
