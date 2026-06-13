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
import type { Profile } from './profiles';
import {
  workspaceContext,
  workspaceUrl,
  handleWorkspaceBoot,
  cachedWorkspaces,
  createWorkspace,
  syncWorkspaces,
  validLabel,
} from '../data/workspaces';
import { renderPerfView } from './views/perfview';
import { renderAbout } from './views/about';
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
      ? profiles.active() ? '/overview' : '/about'
      : readHash().view;
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
      nav,
      el('span', { className: 'masthead-spacer' }),
      el('div', { className: 'masthead-controls' }, [
        workspaceSwitcher(active),
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

/**
 * The masthead pill is a workspace switcher: it shows the current workspace
 * and active profile, and its menu hops between workspaces (each a separate
 * subdomain origin, discovered through the apex directory) and between the
 * profiles saved here. On hosts with no apex (localhost, self-host) it
 * degrades to a profile switcher — no cross-workspace rows.
 */
function workspaceSwitcher(active: Profile | null): HTMLElement {
  const ctx = workspaceContext();
  const here = ctx.current; // '' = home/apex
  // on a real workspace host, lead with the workspace; otherwise just the profile
  const prefix = ctx.apexHost ? `${here || 'home'} · ` : '';
  const pillText = active ? `${prefix}${active.name}` : `${prefix}connect…`;

  const wrap = el('div', { className: 'switcher' });
  const pill = el('button', {
    className: 'chip',
    text: pillText,
    title: active ? `s3://${active.bucket} · ${active.region}` : 'connect a profile',
  });
  wrap.append(pill);

  let pop: HTMLElement | null = null;
  const close = (): void => {
    pop?.remove();
    pop = null;
  };

  function open(): void {
    pop = el('div', { className: 'switcher-pop' });
    wrap.append(pop);

    // profiles saved at THIS origin — activate in place
    const local = profiles.list();
    if (local.length > 0) {
      pop.append(el('div', { className: 'switcher-head', text: here || 'home' }));
      for (const p of local) {
        const row = el('button', {
          className: p.name === active?.name ? 'switcher-row on' : 'switcher-row',
          text: p.name,
        });
        row.append(el('span', { className: 'switcher-sub', text: `s3://${p.bucket}` }));
        row.addEventListener('click', () => {
          close();
          profiles.setActive(p.name);
          setView('/overview');
        });
        pop.append(row);
      }
    }
    pop.append(
      el('button', {
        className: 'switcher-row add',
        text: local.length > 0 ? '+ Add a profile here' : 'Connect a profile…',
        on: { click: () => { close(); setView('/config'); } },
      }),
    );

    // other workspaces — navigate to their subdomain origins (cached
    // snapshot of the apex directory; refreshed on every apex transit)
    if (ctx.apexHost) {
      const others = cachedWorkspaces().filter((n) => n !== here);
      const block = el('div', { className: 'switcher-block' });
      block.append(el('div', { className: 'switcher-head', text: 'Workspaces' }));
      if (here !== '') block.append(workspaceRow('home', ''));
      for (const n of others) block.append(workspaceRow(n, n));
      block.append(
        el('button', {
          className: 'switcher-row add',
          text: '+ New workspace…',
          on: { click: () => { close(); openNewWorkspace(); } },
        }),
        el('button', {
          className: 'switcher-row add',
          text: '↻ Sync workspaces',
          on: { click: () => { close(); syncWorkspaces(readHash().view); } },
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

  function workspaceRow(labelText: string, navLabel: string): HTMLElement {
    const row = el('button', {
      className: navLabel === here ? 'switcher-row on' : 'switcher-row',
      text: labelText || 'home',
    });
    row.addEventListener('click', () => {
      close();
      if (navLabel !== here) location.assign(workspaceUrl(navLabel));
    });
    return row;
  }

  pill.addEventListener('click', () => (pop ? close() : open()));
  return wrap;
}

/**
 * New-workspace modal: name the subdomain, then bounce through the apex
 * (which records it) to that subdomain's config to enter credentials.
 */
function openNewWorkspace(): void {
  const ctx = workspaceContext();
  const overlay = el('div', { className: 'modal-overlay' });
  const input = el('input', {
    className: 'input',
    attrs: { type: 'text', placeholder: 'e.g. acme', autocomplete: 'off', spellcheck: 'false' },
  }) as HTMLInputElement;
  const err = el('div', { className: 'field-note', attrs: { style: 'color:var(--level-error)' } });
  const close = (): void => overlay.remove();

  const submit = (): void => {
    const label = input.value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!validLabel(label)) {
      err.textContent = 'Letters, numbers, and hyphens only.';
      return;
    }
    createWorkspace(label); // → apex records it → lands on its config
  };

  const card = el('div', { className: 'modal-card about-panel' }, [
    el('h2', { text: 'New workspace' }),
    el('p', {
      text:
        `A workspace is a subdomain — your new one will live at ` +
        `${ctx.apexHost ? `«name».${ctx.apexHost}` : '«name»'}. We’ll take you ` +
        `there to add its credentials.`,
    }),
    el('div', { className: 'modal-row' }, [
      input,
      ctx.apexHost ? el('span', { className: 'modal-suffix', text: `.${ctx.apexHost}` }) : el('span'),
    ]),
    err,
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', text: 'Cancel', on: { click: close } }),
      el('button', { className: 'btn btn-primary', text: 'Continue', on: { click: submit } }),
    ]),
  ]);
  overlay.append(card);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
    if (ev.key === 'Escape') close();
  });
  document.body.append(overlay);
  input.focus();
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
