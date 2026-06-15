/**
 * Indexing (#/internals/indexing): what aggregate indexes (SPEC §11) exist and
 * how much they're storing — capability, file/cell counts, serialized bytes, and
 * index-specific stats like the duration histogram's bin occupancy. A
 * copy-as-JSON export makes the numbers easy to paste while tuning (e.g. how
 * many of the histogram's bins are actually used on a real dataset).
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { internalsTabs } from './internals';
import { fmtBytes, fmtCount } from '../format';

export function renderIndexingView(container: HTMLElement): () => void {
  clear(container);
  const section = el('section', { className: 'txn-section' });
  container.append(internalsTabs('/internals/indexing'), section);

  let token = 0;
  async function render(): Promise<void> {
    const t = ++token;
    const stats = await storeClient.request<Record<string, unknown>[]>('indexStats', {});
    if (t !== token || !container.isConnected) return;
    clear(section);

    const json = JSON.stringify(stats, null, 2);
    const copyBtn = el('button', { className: 'btn btn-quiet', text: 'Copy JSON' });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(json);
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => (copyBtn.textContent = 'Copy JSON'), 1200);
    });
    const refreshBtn = el('button', { className: 'btn btn-quiet', text: 'Refresh' });
    refreshBtn.addEventListener('click', () => void render());

    section.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Indexes' }),
        el('span', { className: 'budget faint', text: `${fmtCount(stats.length)} registered` }),
        el('span', { className: 'masthead-spacer' }),
        refreshBtn,
        copyBtn,
      ]),
    );

    // a readable per-index summary above the raw JSON
    for (const ix of stats) {
      const cells = ix.cells as number | undefined;
      const summary = [
        `${ix.files as number} files`,
        cells !== undefined ? `${fmtCount(cells)} cells` : null,
        fmtBytes(ix.bytes as number),
        ix.binsPopulated !== undefined ? `${ix.binsPopulated}/${ix.binsTotal} bins used` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      section.append(
        el('div', { className: 'index-row' }, [
          el('span', { className: 'index-name', text: String(ix.name) }),
          el('span', { className: 'budget faint', text: summary }),
        ]),
      );
    }

    section.append(el('pre', { className: 'indexing-json', text: json }));
  }

  void render();
  return () => {
    token++;
  };
}
