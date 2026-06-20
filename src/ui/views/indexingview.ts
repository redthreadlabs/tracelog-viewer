/**
 * Indexing (#/internals/indexing): the durable aggregate indexes (SPEC §11) —
 * for each, what it answers (its capability) and how much it stores (files,
 * cells, serialized bytes, and the duration histogram's bin occupancy).
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { internalsTabs } from './internals';
import { fmtBytes, fmtCount } from '../format';
import type { IndexCapability } from '../../data/indexes';

const OP_LABEL: Record<string, string> = {
  count: 'count',
  sum: 'Σ',
  avg: 'avg',
  min: 'min',
  max: 'max',
  p95: 'p95',
};

function grainLabel(ms: number): string {
  if (ms === 3_600_000) return 'hourly';
  if (ms === 86_400_000) return 'daily';
  if (ms === 60_000) return 'per minute';
  return `${Math.round(ms / 60_000)}-min grain`;
}

/** A readable one-liner of an index's capability, e.g.
 *  "count · Σ duration  —  by transaction (also host, channel) · hourly · distributive". */
function capabilityLine(cap: IndexCapability): string {
  const provides = cap.provides
    .map((s) => {
      const op = OP_LABEL[s.op] ?? s.op;
      return s.op === 'count' || !s.field ? op : `${op} ${s.field}`;
    })
    .join(' · ');
  let by = `by ${cap.groupBy}`;
  if (cap.fileGroupBy?.length) by += ` (also ${cap.fileGroupBy.join(', ')})`;
  return `${provides}  —  ${by} · ${grainLabel(cap.granularityMs)} · ${cap.merge}`;
}

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

    const refreshBtn = el('button', { className: 'btn btn-quiet', text: 'Refresh' });
    refreshBtn.addEventListener('click', () => void render());

    section.append(
      el('div', { className: 'section-head' }, [
        el('span', { className: 'label', text: 'Indexes' }),
        el('span', { className: 'budget faint', text: `${fmtCount(stats.length)} registered` }),
        el('span', { className: 'masthead-spacer' }),
        refreshBtn,
      ]),
    );

    for (const ix of stats) {
      // Point-lookup indexes (e.g. the origin locator) aren't aggregates — they
      // have no capability line; show their `detail` + their own inventory.
      if (ix.kind === 'point-lookup') {
        const storage = [
          `${ix.files as number} files`,
          `${fmtCount(ix.lifetimes as number)} lifetimes`,
          `${fmtCount(ix.locators as number)} locators`,
          fmtBytes(ix.bytes as number),
        ].join(' · ');
        section.append(
          el('div', { className: 'index-row' }, [
            el('span', { className: 'index-name' }, [
              String(ix.name),
              el('span', { className: 'chip', text: 'point-lookup', attrs: { style: 'margin-left:6px;cursor:default' } }),
            ]),
            el('span', { className: 'index-capability', text: String(ix.detail) }),
            el('span', { className: 'index-storage', text: storage }),
          ]),
        );
        continue;
      }

      const cells = ix.cells as number | undefined;
      const storage = [
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
          el('span', { className: 'index-capability', text: capabilityLine(ix.capability as IndexCapability) }),
          el('span', { className: 'index-storage', text: storage }),
        ]),
      );
    }
  }

  void render();
  return () => {
    token++;
  };
}
