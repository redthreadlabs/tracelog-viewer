/**
 * The scanbar (SPEC §6.0): channel multi-select populated by discovery, a
 * date-range picker with presets, and the download budget — always shown
 * before a scan runs.
 */
import { el, clear } from './dom';
import { LogBucket } from '../s3/client';
import { planScan, type ScanPlan } from '../s3/scanner';
import { executeScan } from '../data/scan';
import { store } from '../data/store';
import { fmtBytes, fmtCount, utcDaysAgo, utcToday } from './format';

interface ScanbarState {
  channels: Map<string, boolean>;
  startDate: string;
  endDate: string;
  plan: ScanPlan | null;
  planning: boolean;
  error?: string;
}

const PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 6 },
  { label: '30d', days: 29 },
];

export function renderScanbar(container: HTMLElement, bucket: LogBucket): void {
  const state: ScanbarState = {
    channels: new Map(),
    startDate: utcToday(),
    endDate: utcToday(),
    plan: null,
    planning: false,
  };

  bucket
    .listChannels()
    .then((channels) => {
      for (const ch of channels) state.channels.set(ch, true);
      void replan();
    })
    .catch((err) => {
      state.error = err instanceof Error ? err.message : String(err);
      render();
    });

  async function replan(): Promise<void> {
    const selected = [...state.channels.entries()].filter(([, on]) => on).map(([ch]) => ch);
    state.plan = null;
    state.error = undefined;
    if (selected.length === 0) {
      render();
      return;
    }
    state.planning = true;
    render();
    try {
      state.plan = await planScan(bucket, selected, state.startDate, state.endDate);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.planning = false;
    render();
  }

  function render(): void {
    clear(container);
    const bar = el('div', { className: 'scanbar' });

    // channels
    const channelGroup = el('div', { className: 'group' }, [
      el('span', { className: 'label', text: 'Channels' }),
    ]);
    if (state.channels.size === 0 && !state.error) {
      channelGroup.append(el('span', { className: 'faint', text: 'discovering…' }));
    }
    for (const [ch, on] of state.channels) {
      channelGroup.append(
        el('button', {
          className: on ? 'chip on' : 'chip',
          text: ch,
          on: {
            click: () => {
              state.channels.set(ch, !on);
              void replan();
            },
          },
        }),
      );
    }
    bar.append(channelGroup);

    // date presets + custom range
    const dateGroup = el('div', { className: 'group' }, [
      el('span', { className: 'label', text: 'Range' }),
    ]);
    for (const preset of PRESETS) {
      const start = utcDaysAgo(preset.days);
      const active = state.startDate === start && state.endDate === utcToday();
      dateGroup.append(
        el('button', {
          className: active ? 'chip on' : 'chip',
          text: preset.label,
          on: {
            click: () => {
              state.startDate = start;
              state.endDate = utcToday();
              void replan();
            },
          },
        }),
      );
    }
    const startInput = dateInput(state.startDate, (v) => {
      state.startDate = v;
      void replan();
    });
    const endInput = dateInput(state.endDate, (v) => {
      state.endDate = v;
      void replan();
    });
    dateGroup.append(startInput, el('span', { className: 'faint', text: '→' }), endInput);
    bar.append(dateGroup);

    // budget + scan
    const right = el('div', { className: 'group', attrs: { style: 'margin-left:auto' } });
    if (state.error) {
      right.append(el('span', { className: 'budget', text: `⚠ ${state.error}` }));
    } else if (state.planning) {
      right.append(el('span', { className: 'budget faint', text: 'listing…' }));
    } else if (state.plan) {
      right.append(
        el('span', {
          className: 'budget',
          html: `would fetch <span class="accent">${fmtCount(state.plan.files.length)} files</span> · <span class="accent">${fmtBytes(state.plan.totalBytes)}</span>`,
        }),
      );
    }
    const scanBtn = el('button', {
      className: 'btn btn-primary',
      text: 'Scan',
      on: {
        click: () => {
          if (state.plan && state.plan.files.length > 0) {
            void executeScan(bucket, state.plan);
          }
        },
      },
    });
    scanBtn.disabled = !state.plan || state.plan.files.length === 0 || store.progress.running;
    right.append(scanBtn);
    bar.append(right);

    container.append(bar);

    // progress thread under the bar
    const progress = el('div', { className: 'progress-thread' });
    const fill = el('div', { className: 'fill' });
    progress.append(fill);
    container.append(progress);
    updateFill(fill);
  }

  function updateFill(fill: HTMLElement): void {
    const { filesTotal, filesDone, running } = store.progress;
    const pct = filesTotal > 0 ? (filesDone / filesTotal) * 100 : 0;
    fill.style.insetInlineEnd = `${100 - (running || pct > 0 ? pct : 0)}%`;
    if (!running && pct >= 100) {
      setTimeout(() => {
        fill.style.insetInlineEnd = '100%';
      }, 600);
    }
  }

  store.addEventListener('progress', () => {
    const fill = container.querySelector<HTMLElement>('.progress-thread .fill');
    if (fill) updateFill(fill);
    const btn = container.querySelector<HTMLButtonElement>('.btn-primary');
    if (btn) btn.disabled = store.progress.running || !state.plan || state.plan.files.length === 0;
  });

  render();
}

function dateInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = el('input', {
    className: 'input mono',
    attrs: { type: 'date', style: 'padding:3px 6px;font-size:12px' },
  });
  input.value = value;
  input.addEventListener('change', () => {
    if (input.value) onChange(input.value);
  });
  return input;
}
