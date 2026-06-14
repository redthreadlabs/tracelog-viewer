/**
 * Client analytics view (SPEC §6.6): client-identified events cut by user and
 * device — sessions (>15 min gaps), app versions in the wild, slow client
 * events, and event types by volume. Rows link into the events view.
 */
import { el, clear, pendingBlock } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import type { Rec } from '../../data/types';
import {
  SLOW_EVENT_MS,
  type ClientProfile,
  type AppVersionStat,
  type EventTypeStat,
} from '../../data/clients';
import { viewState } from '../../state';
import { setView } from '../hashstate';
import { fmtCount, fmtDateTime, fmtDuration } from '../format';

const SLOW_N = 20;

export function renderClientsView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  container.append(body);
  body.append(pendingBlock(200));

  let token = 0;
  async function render(): Promise<void> {
    const t = ++token;
    const doneRender = perf.begin('render', '/clients');
    const data = await storeClient.request<{
      profiles: ClientProfile[];
      versions: AppVersionStat[];
      slow: Rec[];
      types: EventTypeStat[];
    }>('clientsData', { range: viewState.timeRange });
    if (t !== token || !container.isConnected) return;
    clear(body);
    const profiles = data.profiles;

    if (profiles.length === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'No client-identified events in the scan' }),
          el('p', { text: 'Events carrying client identity (device, OS, app version) appear here.' }),
        ]),
      );
      return;
    }

    const versions = data.versions;
    const slow = data.slow;
    const types = data.types;

    // --- stat cards ---
    const cards = el('div', { className: 'stat-cards' });
    const card = (label: string, value: string) =>
      cards.append(
        el('div', { className: 'stat-card' }, [
          el('div', { className: 'label', text: label }),
          el('div', { className: 'stat-value num', text: value }),
        ]),
      );
    card('users', fmtCount(profiles.length));
    card('sessions', fmtCount(profiles.reduce((s, p) => s + p.sessions, 0)));
    card('events', fmtCount(profiles.reduce((s, p) => s + p.events, 0)));
    card('app versions', fmtCount(versions.length));
    card(`slow events (≥${SLOW_EVENT_MS}ms)`, fmtCount(slow.length));
    body.append(el('div', { className: 'stat-row' }, [cards]));

    // --- app versions in the wild ---
    if (versions.length > 0) {
      const mix = el('div', { className: 'result-mix' });
      for (const v of versions) {
        mix.append(
          el('span', { className: 'chip', attrs: { style: 'cursor:default' } }, [
            el('span', { text: v.version }),
            el('span', { className: 'count', text: `${fmtCount(v.users)} users · ${fmtCount(v.events)} ev` }),
          ]),
        );
      }
      body.append(
        el('div', { className: 'section-head' }, [
          el('span', { className: 'label', text: 'App versions in the wild' }),
        ]),
        mix,
      );
    }

    // --- users table ---
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Users' }),
        el('span', { className: 'budget faint', text: 'click to open their events' }),
      ]),
    );
    const usersTable = el('table', { className: 'records txn-table' });
    usersTable.append(
      el('thead', {}, [
        el('tr', {}, [
          th('user', 'width:170px'),
          th('device', ''),
          th('app', 'width:90px'),
          th('sessions', 'width:90px;text-align:right'),
          th('events', 'width:90px;text-align:right'),
          th('errors', 'width:90px;text-align:right'),
          th('last seen', 'width:190px'),
        ]),
      ]),
    );
    const utbody = el('tbody');
    for (const p of profiles) {
      const tr = el('tr', {}, [
        el('td', { className: 'mono', text: p.userId }),
        el('td', { className: 'muted', text: [p.device, p.os].filter(Boolean).join(' · ') }),
        el('td', { className: 'num', text: p.appVersions.join(', ') }),
        el('td', { className: 'num', text: fmtCount(p.sessions), attrs: { style: 'text-align:right' } }),
        el('td', { className: 'num', text: fmtCount(p.events), attrs: { style: 'text-align:right' } }),
        el('td', {
          className: 'num',
          text: p.errors > 0 ? fmtCount(p.errors) : '',
          attrs: { style: 'text-align:right;color:var(--level-error)' },
        }),
        el('td', { className: 'num faint', text: fmtDateTime(p.lastTs) }),
      ]);
      tr.addEventListener('click', () => {
        viewState.pendingEventsUser = p.userId === '(anonymous)' ? '' : p.userId;
        setView('/events');
      });
      utbody.append(tr);
    }
    usersTable.append(utbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none;max-height:340px' } }, [usersTable]));

    // --- slow client events ---
    if (slow.length > 0) {
      body.append(
        el('div', { className: 'section-head', attrs: { style: 'margin-top:14px' } }, [
          el('span', { className: 'label', text: `Slowest client events (≥${SLOW_EVENT_MS} ms)` }),
          el('span', { className: 'budget faint', text: 'click for the ±5 min story around it' }),
        ]),
      );
      const slowTable = el('table', { className: 'records txn-table' });
      slowTable.append(
        el('thead', {}, [
          el('tr', {}, [
            th('time', 'width:190px'),
            th('type', ''),
            th('duration', 'width:110px;text-align:right'),
            th('user', 'width:170px'),
          ]),
        ]),
      );
      const stbody = el('tbody');
      for (const r of slow.slice(0, SLOW_N)) {
        const tr = el('tr', {}, [
          el('td', { className: 'num', text: fmtDateTime(r.ts) }),
          el('td', { className: 'grow', text: r.name, title: r.name }),
          el('td', { className: 'num', text: fmtDuration(r.duration!), attrs: { style: 'text-align:right' } }),
          el('td', { className: 'mono faint', text: r.userId ?? '' }),
        ]);
        tr.addEventListener('click', () => {
          if (r.userId) {
            viewState.userContext = { userId: r.userId, ts: r.ts };
            setView('/events');
          }
        });
        stbody.append(tr);
      }
      slowTable.append(stbody);
      body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [slowTable]));
    }

    // --- event types by volume (funnel raw material) ---
    body.append(
      el('div', { className: 'section-head', attrs: { style: 'margin-top:14px' } }, [
        el('span', { className: 'label', text: 'Event types by volume' }),
      ]),
    );
    const maxCount = Math.max(...types.map((t) => t.count), 1);
    const typesTable = el('table', { className: 'records txn-table' });
    typesTable.append(
      el('thead', {}, [
        el('tr', {}, [
          th('type', 'width:320px'),
          th('count', 'width:100px;text-align:right'),
          th('users', 'width:90px;text-align:right'),
          el('th', {}),
        ]),
      ]),
    );
    const ttbody = el('tbody');
    for (const t of types) {
      const bar = el('div', { className: 'duration-bar' });
      const fill = el('div', { className: 'fill', attrs: { style: 'background: var(--kind-event)' } });
      fill.style.width = `${Math.max((t.count / maxCount) * 100, 0.5)}%`;
      bar.append(fill);
      ttbody.append(
        el('tr', {}, [
          el('td', { className: 'grow', text: t.type, title: t.type, attrs: { style: 'max-width:320px' } }),
          el('td', { className: 'num', text: fmtCount(t.count), attrs: { style: 'text-align:right' } }),
          el('td', { className: 'num', text: fmtCount(t.users), attrs: { style: 'text-align:right' } }),
          el('td', {}, [bar]),
        ]),
      );
    }
    typesTable.append(ttbody);
    body.append(el('div', { className: 'txn-wrap', attrs: { style: 'flex:none' } }, [typesTable]));
    doneRender();
  }

  const onData = () => void render();
  storeClient.addEventListener('data', onData);
  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
  };
}

function th(text: string, style: string): HTMLElement {
  return el('th', { className: 'label', text, attrs: style ? { style } : undefined });
}
