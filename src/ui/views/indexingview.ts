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
import { fmtBytes, fmtCount, fmtDuration } from '../format';
import { viewState } from '../../state';

interface AccuracyRow {
  name: string;
  n: number;
  exact: number;
  estimated: number | null;
  errorPct: number | null;
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

    // P95 accuracy: the histogram's estimate beside the exact (loaded-records)
    // value, per transaction — the bin-resolution error on real data. Surface
    // any worker error here rather than letting a rejection silently drop the
    // table (e.g. a stale pre-deploy worker that lacks this op).
    try {
      const acc = await storeClient.request<AccuracyRow[]>('p95Accuracy', {
        range: viewState.timeRange,
      });
      if (t !== token || !container.isConnected) return;
      renderAccuracy(section, acc);
    } catch (err) {
      if (t !== token || !container.isConnected) return;
      const msg = err instanceof Error ? err.message : String(err);
      section.append(
        el('div', { className: 'section-head', attrs: { style: 'margin-top:24px' } }, [
          el('span', { className: 'label', text: 'P95 accuracy' }),
        ]),
        el('div', { className: 'budget faint', attrs: { style: 'margin:-4px 0 8px' } }, [
          el('span', {
            text: /unknown op/.test(msg)
              ? 'unavailable — close every tracelog tab and reopen to pick up the latest build, then retry'
              : `unavailable — ${msg}`,
          }),
        ]),
      );
    }
  }

  void render();
  return () => {
    token++;
  };
}

/** The estimated-vs-exact P95 table — the histogram's accuracy on loaded data. */
function renderAccuracy(section: HTMLElement, rows: AccuracyRow[]): void {
  const errs = rows.map((r) => r.errorPct).filter((e): e is number => e !== null).sort((a, b) => a - b);
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : undefined;
  const worst = errs.length ? errs[errs.length - 1] : undefined;
  const summary =
    median !== undefined
      ? `${median.toFixed(1)}% median · ${worst!.toFixed(1)}% worst error (${fmtCount(rows.length)} txns)`
      : 'no overlap with loaded records';

  section.append(
    el('div', { className: 'section-head', attrs: { style: 'margin-top:24px' } }, [
      el('span', { className: 'label', text: 'P95 accuracy' }),
      el('span', { className: 'budget faint', text: summary }),
    ]),
    el('div', { className: 'budget faint', attrs: { style: 'margin:-4px 0 8px' } }, [
      el('span', {
        text: 'estimated (histogram) vs exact (loaded records), per transaction — the bin-resolution error',
      }),
    ]),
  );

  const head = el('div', { className: 'index-row idx-acc-head' }, [
    el('span', { text: 'transaction' }),
    el('span', { className: 'idx-num', text: 'count' }),
    el('span', { className: 'idx-num', text: 'exact P95' }),
    el('span', { className: 'idx-num', text: 'estimated' }),
    el('span', { className: 'idx-num', text: 'error' }),
  ]);
  const table = el('div', { className: 'idx-acc' }, [head]);
  for (const r of rows) {
    table.append(
      el('div', { className: 'index-row idx-acc-row' }, [
        el('span', { className: 'index-name', text: r.name }),
        el('span', { className: 'idx-num faint', text: fmtCount(r.n) }),
        el('span', { className: 'idx-num', text: fmtDuration(r.exact) }),
        el('span', { className: 'idx-num', text: r.estimated !== null ? fmtDuration(r.estimated) : '—' }),
        el('span', {
          className: 'idx-num' + (r.errorPct !== null && r.errorPct > 25 ? ' idx-err-hi' : ''),
          text: r.errorPct !== null ? `${r.errorPct.toFixed(1)}%` : '—',
        }),
      ]),
    );
  }
  section.append(table);
}
