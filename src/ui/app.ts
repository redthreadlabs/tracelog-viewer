/**
 * Shell: masthead, hash routing (#/records, #/config), theme & UTC toggles
 * (SPEC §5–6). The masthead is underlined by the red thread — a clean rule
 * in the brand color running the width of the page.
 */
import { el, clear } from './dom';
import { initTheme, toggleTheme, currentTheme } from './theme';
import { setUtcMode, isUtcMode, zoneLabel } from './format';
import { profiles } from './profiles';
import { renderConfig } from './config';
import { renderScanbar } from './scanbar';
import { readHash, setView, setParams, rangeFromParams } from './hashstate';
import { viewState, resetViewState } from '../state';
import { storeClient } from '../data/storeclient';
import type { Profile } from './profiles';
import {
  workspaceContext,
  hopToWorkspace,
  handleWorkspaceBoot,
  knownWorkspaces,
  isApexHome,
} from '../data/workspaces';
import { openNewWorkspace } from './workspaceui';
import { renderPerfView } from './views/perfview';
import { renderAbout } from './views/about';
import { renderRecordsView } from './views/records';
import { renderEventsView } from './views/events';
import { renderMetricsView } from './views/metrics';
import { renderClientsView } from './views/clients';
import { renderScannerView } from './views/scanner';
import { renderStoreView } from './views/storeview';
import { renderIndexingView } from './views/indexingview';
import { renderOverview } from './views/overview';
import { renderTraceView } from './views/trace';
import { renderTransactionView } from './views/transaction';

// Masthead theme-toggle icons (our own SVGs, not font glyphs, for a consistent
// shape). Both fill/stroke with currentColor so .toggle-ico.sun/.moon drive the
// color. Sun: a prominent filled disc + eight short, thick rays. Moon: a solid
// filled crescent (not an outline).
const SUN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="5.2" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
  '<line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/>' +
  '<line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/>' +
  '<line x1="5.3" y1="5.3" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="18.7" y2="18.7"/>' +
  '<line x1="5.3" y1="18.7" x2="7.05" y2="16.95"/><line x1="16.95" y1="7.05" x2="18.7" y2="5.3"/>' +
  '</g></svg>';
const MOON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>';

const NAV: { view: string; label: string }[] = [
  { view: '/about', label: 'About' },
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
  // Workspace directory boot: absorb a relay return, serve a relay request
  // if we're the apex, or auto-sync on a fresh subdomain. When it takes over
  // (a navigation is in flight) we render nothing.
  if (handleWorkspaceBoot()) return;

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

    // mirror route()'s bare-URL delegation so the nav highlights correctly
    const bare = !location.hash || location.hash === '#' || location.hash === '#/';
    const currentView = bare
      ? profiles.active() && !isApexHome() ? '/overview' : '/about'
      : readHash().view;
    // the zone (TIME) toggle only affects how log timestamps render, so it
    // belongs on the log-data views (where the scanbar shows) plus the store
    // inspector (which renders file lastModified times in the active zone) —
    // hidden on About, the Connect/config path, the other internals, and the apex
    const showZone = shouldShowScanbar() || currentView === '/internals/store';
    // the apex is the public landing only — no data views in its nav
    const navItems = isApexHome() ? NAV.filter((i) => i.view === '/about') : NAV;
    const nav = el('nav', { className: 'masthead-nav' });
    for (const item of navItems) {
      nav.append(
        el('button', {
          className: item.view === currentView ? 'nav-link on' : 'nav-link',
          text: item.label,
          on: { click: () => setView(item.view) },
        }),
      );
    }

    // Zone toggle — shows the CURRENT time zone (the word "UTC", or the zone
    // name like "New York"), not an on/off state. Flips the display zone and
    // re-renders the active view.
    const zoneBtn = el('button', { className: 'toggle', title: 'show times in UTC or your time zone' });
    const paintZone = (): void => {
      clear(zoneBtn);
      zoneBtn.append(
        el('span', { className: 'toggle-label', text: 'TIME:' }),
        el('span', { text: zoneLabel() }),
      );
    };
    paintZone();
    zoneBtn.addEventListener('click', () => {
      setUtcMode(!isUtcMode());
      paintZone();
      route(); // re-render the active view with the new zone
    });

    // Theme toggle — shows the CURRENT mode: the word + a sun (light, amber) or
    // moon (dark, grey) icon. A theme change is a restyle, not a rebuild:
    // toggleTheme flips data-theme (the cascade re-skins everything) and fires
    // THEME_CHANGE_EVENT for the charts to redraw; no route(), so view state
    // (e.g. the overview's row selection) survives. We just repaint this button.
    const themeBtn = el('button', { className: 'toggle', title: 'switch light / dark theme' });
    const paintTheme = (): void => {
      const dark = currentTheme() === 'dark';
      clear(themeBtn);
      themeBtn.append(
        el('span', { className: `toggle-ico ${dark ? 'moon' : 'sun'}`, html: dark ? MOON_ICON : SUN_ICON }),
        el('span', { text: dark ? 'DARK' : 'LIGHT' }),
      );
    };
    paintTheme();
    themeBtn.addEventListener('click', () => {
      toggleTheme();
      paintTheme();
    });

    const masthead = el('div', { className: 'masthead' }, [
      el('span', { className: 'masthead-title', text: 'Tracelog' }),
      nav,
      el('span', { className: 'masthead-spacer' }),
      el('div', { className: 'masthead-controls' }, [
        workspaceSwitcher(active),
        ...(showZone ? [zoneBtn] : []),
        themeBtn,
      ]),
    ]);

    header.append(masthead);
  }

  // the scanbar (channel/range filters) belongs to the log-data views only —
  // not the config form, the About page, the apex landing, or the
  // viewer-internals pages (which are about the app, not the logs)
  function shouldShowScanbar(): boolean {
    if (!profiles.active() || isApexHome()) return false;
    const bareUrl = !location.hash || location.hash === '#' || location.hash === '#/';
    const view = bareUrl ? '/overview' : readHash().view;
    return view !== '/config' && view !== '/about' && !view.startsWith('/internals/');
  }

  // the scanbar instance persists across navigation — we just show or hide its
  // host, so moving between views never tears it down or re-loads its data
  function applyScanbarVisibility(): void {
    scanbarHost.style.display = shouldShowScanbar() ? '' : 'none';
  }

  function renderScanbarIfConnected(): void {
    clear(scanbarHost);
    if (profiles.active()) renderScanbar(scanbarHost);
    applyScanbarVisibility();
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
    applyScanbarVisibility(); // view-tier only: the scanbar shows on data views

    // The apex is the public landing + directory keeper, never a workspace:
    // no profiles or data live here, so it only ever shows About. (The relay
    // route is handled in handleWorkspaceBoot, before we ever get here.)
    if (isApexHome()) {
      teardown = renderAbout(main);
      return;
    }

    // a bare URL delegates: newcomers land on About, returning users on data
    const bareUrl = !location.hash || location.hash === '#' || location.hash === '#/';
    const view = bareUrl
      ? profiles.active() ? '/overview' : '/about'
      : readHash().view;
    // About is the one public page; everything else needs a profile first
    if (view === '/about') {
      teardown = renderAbout(main);
      return;
    }
    if (!profiles.active() || view === '/config') {
      renderConfig(main, () => {
        connect();
        setView('/overview');
      });
      return;
    }
    // views self-time their async renders (op + clone + DOM) — timing the
    // synchronous scaffolding here would claim 0 ms for everything
    teardown = renderView(view);
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
    if (view === '/internals/indexing') return renderIndexingView(main);
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

  // restore the selected time range (`from`/`to`, epoch-ms) on boot
  viewState.timeRange = rangeFromParams();

  connect();
  route();
}

/**
 * The masthead pill is a workspace switcher. A workspace is always a
 * subdomain, with one connection (bucket) — there is no separate profile
 * name, and no apex/home workspace. Three contexts:
 *  • apex: the launcher — pick an existing workspace or make a new one;
 *  • subdomain: this workspace's connection + a jump to the others;
 *  • localhost/self-host single-origin: just this origin's connection.
 */
function workspaceSwitcher(active: Profile | null): HTMLElement {
  const ctx = workspaceContext();
  const here = ctx.current;
  const apex = isApexHome();
  const wrap = el('div', { className: 'switcher' });
  const pill = el('button', {
    className: 'chip',
    title: active ? `s3://${active.bucket} · ${active.region}` : 'workspaces',
  });
  if (apex) {
    pill.textContent = 'Workspaces'; // the launcher, not a single workspace
  } else if (ctx.apexHost) {
    // a named subdomain workspace — label it "workspace: <name>"
    pill.append(
      el('span', { className: 'chip-label', text: 'workspace:' }),
      el('span', { text: active ? here : `${here} · connect…` }),
    );
  } else {
    // single-origin (localhost/self-host): this origin's connection, not a named workspace
    pill.textContent = active ? active.bucket || 'connected' : 'connect…';
  }
  wrap.append(pill);

  let pop: HTMLElement | null = null;
  const close = (): void => {
    pop?.remove();
    pop = null;
  };

  function workspaceRow(label: string): HTMLElement {
    const row = el('button', {
      className: label === here ? 'switcher-row on' : 'switcher-row',
      text: label,
    });
    row.addEventListener('click', () => {
      close();
      if (label !== here) hopToWorkspace(label);
    });
    return row;
  }

  function open(): void {
    pop = el('div', { className: 'switcher-pop' });
    wrap.append(pop);

    // (1) this workspace's connection — edit or set it up
    if (!apex) {
      pop.append(
        el('button', {
          className: 'switcher-row add',
          text: active ? 'Edit Workspace…' : 'Connect this workspace…',
          on: { click: () => { close(); setView('/config'); } },
        }),
      );
    }

    // (2) divider + (3) links to the other workspaces + (4) New workspace
    if (ctx.apexHost) {
      const others = knownWorkspaces().filter((n) => n !== here);
      const block = el('div', { className: apex ? '' : 'switcher-block' });
      for (const n of others) block.append(workspaceRow(n));
      block.append(
        el('button', {
          className: 'switcher-row add',
          text: '+ New workspace…',
          on: { click: () => { close(); openNewWorkspace(); } },
        }),
      );
      pop.append(block);
    }

    // close on outside click
    setTimeout(() => {
      const onDown = (ev: MouseEvent): void => {
        if (!pop) {
          document.removeEventListener('mousedown', onDown);
          return;
        }
        if (!wrap.contains(ev.target as Node)) {
          document.removeEventListener('mousedown', onDown);
          close();
        }
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
  }

  pill.addEventListener('click', () => (pop ? close() : open()));
  return wrap;
}

/** The red thread: slight waves, one small loop — drawn once, full width. */
