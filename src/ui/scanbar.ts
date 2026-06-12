/**
 * The scanbar (SPEC §6.0): channel multi-select populated by discovery, a
 * datetime-range picker with presets, and the download budget — always
 * shown before a scan runs.
 *
 * Granularity note: S3 files are daily, so the listing/fetch is driven by
 * the UTC *days* covering the range; the time-of-day component narrows the
 * viewed window instead (viewState.timeWindow — the same mechanism as the
 * chart brush, encoded in the `w` hash param). Quick presets ("15 min")
 * scan the covering day(s) and window down to the precise range.
 */
import { el, clear } from './dom';
import { LogBucket } from '../s3/client';
import { planScan, type ScanPlan } from '../s3/scanner';
import { executeScan } from '../data/scan';
import { LiveUpdater } from '../data/live';
import { store } from '../data/store';
import { viewState } from '../state';
import { fmtBytes, fmtCount } from './format';
import { getParam, setParams, setView, parseWindowParam, windowParam } from './hashstate';

interface ScanbarState {
  channels: Map<string, boolean>;
  /** the selected range, epoch-ms (end may be "now" for quick presets) */
  startMs: number;
  endMs: number;
  /** whole-day ranges don't narrow the time window after scanning */
  wholeDays: boolean;
  plan: ScanPlan | null;
  planning: boolean;
  live: boolean;
  error?: string;
}

const DAY_MS = 86_400_000;

const QUICK_PRESETS: { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 hr', minutes: 60 },
  { label: '6 hr', minutes: 360 },
];

const DAY_PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '7d', days: 6 },
  { label: '30d', days: 29 },
];

/** UTC day label ("2026-06-12") containing an instant. */
function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** start of the UTC day N days before today */
function utcDayStart(daysAgo: number): number {
  const today = new Date();
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - daysAgo * DAY_MS;
}

/** epoch-ms → value for <input type="datetime-local"> (local clock) */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// One live updater per scanbar instance; re-rendering the scanbar (e.g. on
// profile change) must stop the previous one.
let activeLive: LiveUpdater | null = null;

export function renderScanbar(container: HTMLElement, bucket: LogBucket): void {
  activeLive?.stop();

  // initial range: a shared URL's precise window wins; else its day params;
  // else today.
  const sharedWindow = parseWindowParam(getParam('w'));
  const fromDay = getParam('from');
  const toDay = getParam('to');
  const state: ScanbarState = sharedWindow
    ? {
        channels: new Map(),
        startMs: sharedWindow[0],
        endMs: sharedWindow[1],
        wholeDays: false,
        plan: null,
        planning: false,
        live: false,
      }
    : {
        channels: new Map(),
        startMs: fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : utcDayStart(0),
        endMs: toDay ? Date.parse(`${toDay}T00:00:00Z`) + DAY_MS - 1 : Date.now(),
        wholeDays: true,
        plan: null,
        planning: false,
        live: false,
      };

  const live = new LiveUpdater(bucket, () =>
    [...state.channels.entries()].filter(([, on]) => on).map(([ch]) => ch),
  );
  activeLive = live;

  bucket
    .listChannels()
    .then((channels) => {
      // a shared URL's ch=a,b narrows the default all-on selection
      const fromUrl = getParam('ch')?.split(',').filter(Boolean);
      for (const ch of channels) {
        state.channels.set(ch, !fromUrl || fromUrl.includes(ch));
      }
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
    setParams({
      ch: selected.length === state.channels.size ? null : selected.join(','),
      from: utcDayOf(state.startMs),
      to: utcDayOf(state.endMs),
    });
    render();
    try {
      state.plan = await planScan(bucket, selected, utcDayOf(state.startMs), utcDayOf(state.endMs));
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.planning = false;
    render();
  }

  function setRange(startMs: number, endMs: number, wholeDays: boolean): void {
    state.startMs = startMs;
    state.endMs = Math.max(endMs, startMs + 60_000);
    state.wholeDays = wholeDays;
    void replan();
  }

  function runScan(): void {
    if (!state.plan || state.plan.files.length === 0) return;
    void executeScan(bucket, state.plan); // resets viewState synchronously first
    if (state.wholeDays) {
      viewState.timeWindow = null;
      setParams({ w: null });
    } else {
      // sub-day precision: narrow the viewed window, same as a brush
      viewState.timeWindow = [state.startMs, state.endMs];
      setParams({ w: windowParam(viewState.timeWindow) });
    }
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

    // range presets + datetime inputs
    const dateGroup = el('div', { className: 'group' }, [
      el('span', { className: 'label', text: 'Range' }),
    ]);
    for (const preset of QUICK_PRESETS) {
      const now = Date.now();
      const active =
        !state.wholeDays &&
        Math.abs(state.endMs - now) < 90_000 &&
        Math.abs(state.endMs - state.startMs - preset.minutes * 60_000) < 30_000;
      dateGroup.append(
        el('button', {
          className: active ? 'chip on' : 'chip',
          text: preset.label,
          title: `the last ${preset.label} (scans the covering day, windows the views)`,
          on: {
            click: () => setRange(Date.now() - preset.minutes * 60_000, Date.now(), false),
          },
        }),
      );
    }
    for (const preset of DAY_PRESETS) {
      const presetStart = utcDayStart(preset.days);
      const active =
        state.wholeDays &&
        state.startMs === presetStart &&
        utcDayOf(state.endMs) === utcDayOf(Date.now());
      dateGroup.append(
        el('button', {
          className: active ? 'chip on' : 'chip',
          text: preset.label,
          on: {
            click: () => setRange(presetStart, Date.now(), true),
          },
        }),
      );
    }
    const startInput = datetimeInput(state.startMs, (ms) => setRange(ms, state.endMs, false));
    const endInput = datetimeInput(state.endMs, (ms) => setRange(state.startMs, ms, false));
    dateGroup.append(startInput, el('span', { className: 'faint', text: '→' }), endInput);
    bar.append(dateGroup);

    // budget + live + scan
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
    const liveChip = el('button', {
      className: state.live ? 'chip live on' : 'chip live',
      title: "refresh today's _current snapshots every 60 s",
      on: {
        click: () => {
          state.live = !state.live;
          if (state.live) {
            // live mode watches today: extend the range to include now
            if (state.endMs < Date.now()) state.endMs = Date.now();
            live.start();
          } else {
            live.stop();
          }
          render();
        },
      },
    });
    liveChip.append(el('span', { className: 'dot' }), el('span', { text: 'LIVE' }));
    right.append(liveChip);

    const scanBtn = el('button', {
      className: 'btn btn-primary',
      text: 'Scan',
      on: { click: runScan },
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
    updateLoadedText();
  });

  store.addEventListener('data', updateLoadedText);

  function updateLoadedText(): void {
    const { running, filesTotal, filesDone, filesFromCache } = store.progress;
    const budget = container.querySelector<HTMLElement>('.budget');
    if (!budget || filesTotal === 0) return;
    if (running) {
      budget.textContent = `fetching ${filesDone}/${filesTotal}…`;
      return;
    }
    if (store.records.length === 0 && store.files.size === 0) return;
    clearEl(budget);
    const link = document.createElement('a');
    link.href = '#/store';
    link.className = 'store-link';
    link.title = 'inspect the in-memory store';
    link.innerHTML = `<span class="accent">${fmtCount(store.records.length)} records</span> from <span class="accent">${fmtCount(store.files.size)} files</span>${
      filesFromCache > 0 ? ` · ${fmtCount(filesFromCache)} from cache` : ''
    }`;
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      setView('/store');
    });
    budget.append(link);
  }

  function clearEl(node: HTMLElement): void {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  render();
}

function datetimeInput(ms: number, onChange: (ms: number) => void): HTMLInputElement {
  const input = el('input', {
    className: 'input mono',
    attrs: { type: 'datetime-local', style: 'padding:3px 6px;font-size:12px' },
  });
  input.value = toLocalInput(ms);
  input.addEventListener('change', () => {
    if (!input.value) return;
    const parsed = Date.parse(input.value); // local time, like the picker shows
    if (isFinite(parsed)) onChange(parsed);
  });
  return input;
}
