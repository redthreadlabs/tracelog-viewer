/**
 * Scanner traffic view (SPEC §6.7): a deliberately small page for the
 * unmatched-route transactions — probes per day, top paths, top user agents, top
 * source IPs. Mostly entertainment.
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import { type ScannerStats, type RankedCount } from '../../data/scanner-traffic';
import { viewState } from '../../state';
import { fmtCount } from '../format';

export function renderScannerView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  container.append(body);

  let token = 0;
  async function render(): Promise<void> {
    const t = ++token;
    const doneRender = perf.begin('render', '/scanner');
    const stats = await storeClient.request<ScannerStats>('scannerData', {
      window: viewState.timeWindow,
    });
    if (t !== token || !container.isConnected) return;
    clear(body);

    if (stats.total === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'No scanner traffic in the scan' }),
          el('p', { text: 'Requests that matched no route (\u201cGET unknown route\u201d) appear here.' }),
        ]),
      );
      return;
    }

    const cards = el('div', { className: 'stat-cards' });
    cards.append(
      el('div', { className: 'stat-card' }, [
        el('div', { className: 'label', text: 'probes' }),
        el('div', { className: 'stat-value num', text: fmtCount(stats.total) }),
      ]),
      el('div', { className: 'stat-card' }, [
        el('div', { className: 'label', text: 'days' }),
        el('div', { className: 'stat-value num', text: fmtCount(stats.perDay.length) }),
      ]),
    );
    body.append(el('div', { className: 'stat-row' }, [cards]));

    // probes per day — a small ledger of bars
    const maxDay = Math.max(...stats.perDay.map((d) => d.count), 1);
    body.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Probes per day' }),
      ]),
    );
    const days = el('div', { className: 'scanner-days' });
    for (const d of stats.perDay) {
      const bar = el('div', { className: 'duration-bar', attrs: { style: 'flex:1' } });
      const fill = el('div', { className: 'fill', attrs: { style: 'background: var(--spantype-other)' } });
      fill.style.width = `${Math.max((d.count / maxDay) * 100, 1)}%`;
      bar.append(fill);
      days.append(
        el('div', { className: 'scanner-day' }, [
          el('span', { className: 'num faint', text: d.day }),
          bar,
          el('span', { className: 'num', text: fmtCount(d.count) }),
        ]),
      );
    }
    body.append(days);

    // three ranked lists
    const grid = el('div', { className: 'scanner-grid' });
    grid.append(
      rankedList('Top paths', stats.topPaths),
      rankedList('Top user agents', stats.topAgents),
      rankedList('Top source IPs', stats.topIps),
    );
    body.append(grid);
    doneRender();
  }

  function rankedList(title: string, items: RankedCount[]): HTMLElement {
    const section = el('div', {}, [
      el('div', { className: 'section-head' }, [el('span', { className: 'label', text: title })]),
    ]);
    const list = el('div', { className: 'ranked-list' });
    const max = Math.max(...items.map((i) => i.count), 1);
    for (const item of items) {
      const row = el('div', { className: 'ranked-row', title: item.key });
      const fill = el('div', { className: 'ranked-fill' });
      fill.style.width = `${Math.max((item.count / max) * 100, 1)}%`;
      row.append(
        fill,
        el('span', { className: 'mono ranked-key', text: item.key }),
        el('span', { className: 'num ranked-count', text: fmtCount(item.count) }),
      );
      list.append(row);
    }
    section.append(list);
    return section;
  }

  const onData = () => void render();
  storeClient.addEventListener('data', onData);
  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
  };
}
