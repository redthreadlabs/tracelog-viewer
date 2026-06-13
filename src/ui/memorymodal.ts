/**
 * Memory-limit modal (SPEC §8): the guardrail that fires when a selected
 * view is estimated to need more in-memory bytes than this workspace's
 * memory limit allows. It explains the cost and offers three ways out —
 * raise the limit and load it all, clamp to the most-recent files that fit,
 * or cancel and leave the current data in place. The estimate is exactly
 * that (decompressed size is only known for certain after fetching), so this
 * is a speed bump, not a hard cap.
 */
import { el } from './dom';
import { fmtBytesRough } from './format';

export interface MemoryModalOpts {
  /** estimated decompressed bytes for the whole selected view */
  estBytes: number;
  /** the workspace's memory limit, bytes */
  limitBytes: number;
  /** number of files in the full view */
  fileCount: number;
  /** how many files the clamp keeps, and their estimated bytes */
  fitCount: number;
  fitBytes: number;
  /** load the whole view after raising the limit to `newLimitMb` */
  onRaise: (newLimitMb: number) => void;
  /** load only the most-recent files that fit */
  onClamp: () => void;
  /** leave the currently-loaded data as-is */
  onCancel: () => void;
}

const MB = 1024 * 1024;

/** Round an MB figure up to the next 64 MB, for a little headroom. */
function niceLimitMb(bytes: number): number {
  return Math.max(64, Math.ceil(bytes / MB / 64) * 64);
}

export function openMemoryLimitModal(opts: MemoryModalOpts): void {
  const overlay = el('div', { className: 'modal-overlay' });
  const close = (): void => overlay.remove();
  const newLimitMb = niceLimitMb(opts.estBytes);

  const raise = el('button', {
    className: 'btn btn-primary',
    text: `Raise limit to ${newLimitMb} MB & load`,
    on: { click: () => { close(); opts.onRaise(newLimitMb); } },
  });
  const clamp = el('button', {
    className: 'btn',
    text: `Load newest that fits (~${fmtBytesRough(opts.fitBytes)}, ${opts.fitCount} of ${opts.fileCount})`,
    on: { click: () => { close(); opts.onClamp(); } },
  });
  // the clamp is only worth offering when it actually drops something
  const showClamp = opts.fitCount < opts.fileCount;

  const card = el('div', { className: 'modal-card about-panel' }, [
    el('h2', {
      text: 'This view is large',
      attrs: { style: 'text-align:center;font-style:italic' },
    }),
    el('p', { className: 'field-note', attrs: { style: 'margin-top:18px' } }, [
      el('span', { text: 'Loading these ' }),
      el('strong', { text: `${opts.fileCount} files` }),
      el('span', { text: ' is estimated to hold about ' }),
      el('strong', { attrs: { style: 'font-style:italic' }, text: fmtBytesRough(opts.estBytes) }),
      el('span', {
        text: ` in memory, above this workspace's ${fmtBytesRough(opts.limitBytes)} limit.`,
      }),
    ]),
    el('p', {
      className: 'field-note',
      text:
        'The estimate comes from the compression ratios of files seen so far, ' +
        'so it is approximate. You can raise the limit for this workspace, load ' +
        'just the most recent data that fits, or cancel and narrow the channels ' +
        'or time range yourself.',
    }),
    el('div', { className: 'modal-actions' }, [
      el('button', { className: 'btn', text: 'Cancel', on: { click: () => { close(); opts.onCancel(); } } }),
      ...(showClamp ? [clamp] : []),
      raise,
    ]),
  ]);

  overlay.append(card);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { close(); opts.onCancel(); }
  });
  document.addEventListener('keydown', function onKey(ev) {
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (ev.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); opts.onCancel(); }
  });
  document.body.append(overlay);
}
