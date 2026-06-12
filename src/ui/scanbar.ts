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
 *
 * UX rule: files are plumbing. Setting a range *is* the user's intent —
 * the app fetches whatever satisfies it, behind the scenes, with progress
 * as the only acknowledgment. File detail lives in the store inspector,
 * on demand.
 */
import { el, clear } from './dom';
import { LogBucket } from '../s3/client';
import { planScan, type ScanPlan } from '../s3/scanner';
import { executeScan } from '../data/scan';
import { LiveUpdater } from '../data/live';
import { store } from '../data/store';
import { viewState } from '../state';
import { fmtBytes, fmtCount } from './format';
import { getParam, setParams, setView, parseWindowParam, windowParam, readHash } from './hashstate';
import { renderBucketPicker } from './bucketpicker';

interface ScanbarState {
  channels: Map<string, boolean>;
  /** the selected range, epoch-ms (end may be "now" for quick presets) */
  startMs: number;
  endMs: number;
  /** whole-day ranges don't narrow the time window after scanning */
  wholeDays: boolean;
  rangeOpen: boolean;
  plan: ScanPlan | null;
  planning: boolean;
  live: boolean;
  error?: string;
}

const DAY_MS = 86_400_000;

const QUICK_PRESETS: { label: string; minutes: number }[] = [
  { label: 'Last 15 min', minutes: 15 },
  { label: 'Last 1 hr', minutes: 60 },
  { label: 'Last 6 hr', minutes: 360 },
  { label: 'Last 12 hr', minutes: 720 },
  { label: 'Last 24 hr', minutes: 1440 },
];

const DAY_PRESETS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 6 },
  { label: 'Last 30 days', days: 29 },
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** compact local "Jun 10, 09:14" for the pill */
function shortStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

/** views whose charts bucket records by time — the bars picker applies */
const BUCKETED_VIEWS = new Set(['/overview', '/metrics']);

// One live updater per scanbar instance; re-rendering the scanbar (e.g. on
// profile change) must stop the previous one — same for the hashchange
// listener that shows/hides the bars picker per view.
let activeLive: LiveUpdater | null = null;
let activeHashHandler: (() => void) | null = null;

export function renderScanbar(container: HTMLElement, bucket: LogBucket): void {
  activeLive?.stop();
  if (activeHashHandler) window.removeEventListener('hashchange', activeHashHandler);

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
        rangeOpen: false,
        plan: null,
        planning: false,
        live: false,
      }
    : {
        channels: new Map(),
        startMs: fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : utcDayStart(0),
        endMs: toDay ? Date.parse(`${toDay}T00:00:00Z`) + DAY_MS - 1 : Date.now(),
        wholeDays: true,
        rangeOpen: false,
        plan: null,
        planning: false,
        live: false,
      };

  const live = new LiveUpdater(bucket, () =>
    [...state.channels.entries()].filter(([, on]) => on).map(([ch]) => ch),
  );
  activeLive = live;

  // identity of the currently loaded plan, so range fiddling that resolves
  // to the same data doesn't reload, and new data auto-loads at most once
  let loadedSignature: string | null = null;

  function planSignature(plan: ScanPlan): string {
    return plan.files.map((f) => `${f.key}@${f.etag ?? ''}`).join('|');
  }

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
    maybeAutoLoad();
    render();
  }

  function maybeAutoLoad(): void {
    if (!state.plan || state.plan.files.length === 0) return;
    if (store.progress.running) return;
    if (planSignature(state.plan) === loadedSignature) {
      // same data, possibly a different slice of it: apply the window and
      // re-render the views without refetching anything
      applyWindow();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    runScan();
  }

  /** Narrow (or clear) the viewed time window to match the selected range. */
  function applyWindow(): void {
    if (state.wholeDays) {
      viewState.timeWindow = null;
      setParams({ w: null });
    } else {
      // sub-day precision: narrow the viewed window, same as a brush
      viewState.timeWindow = [state.startMs, state.endMs];
      setParams({ w: windowParam(viewState.timeWindow) });
    }
  }

  function setRange(startMs: number, endMs: number, wholeDays: boolean): void {
    state.startMs = startMs;
    state.endMs = Math.max(endMs, startMs + 60_000);
    state.wholeDays = wholeDays;
    void replan();
  }

  function runScan(): void {
    if (!state.plan || state.plan.files.length === 0) return;
    loadedSignature = planSignature(state.plan);
    void executeScan(bucket, state.plan); // resets viewState synchronously first
    applyWindow();
  }

  function currentPresetLabel(): string | null {
    const now = Date.now();
    for (const preset of QUICK_PRESETS) {
      if (
        !state.wholeDays &&
        Math.abs(state.endMs - now) < 90_000 &&
        Math.abs(state.endMs - state.startMs - preset.minutes * 60_000) < 30_000
      ) {
        return preset.label;
      }
    }
    for (const preset of DAY_PRESETS) {
      if (
        state.wholeDays &&
        state.startMs === utcDayStart(preset.days) &&
        utcDayOf(state.endMs) === utcDayOf(now)
      ) {
        return preset.label;
      }
    }
    return null;
  }

  function renderRangePop(): HTMLElement {
    const pop = el('div', { className: 'range-pop' });
    const active = currentPresetLabel();

    // left: presets as a vertical menu
    const presets = el('div', { className: 'range-presets' });
    const item = (label: string, onPick: () => void) =>
      presets.append(
        el('button', {
          className: label === active ? 'range-preset on' : 'range-preset',
          text: label.replace('Last ', ''),
          on: {
            click: () => {
              state.rangeOpen = false;
              onPick();
            },
          },
        }),
      );
    for (const preset of QUICK_PRESETS) {
      item(preset.label, () =>
        setRange(Date.now() - preset.minutes * 60_000, Date.now(), false),
      );
    }
    for (const preset of DAY_PRESETS) {
      item(preset.label, () => setRange(utcDayStart(preset.days), Date.now(), true));
    }

    // right: custom range, inputs stacked, Apply in the lower-right
    const startInput = datetimeInput(state.startMs, () => {});
    const endInput = datetimeInput(state.endMs, () => {});
    const custom = el('div', { className: 'range-custom-col' }, [
      el('div', { className: 'label scol-title', text: 'Custom' }),
      el('div', { className: 'range-field' }, [
        el('span', { className: 'label', text: 'start' }),
        startInput,
      ]),
      el('div', { className: 'range-field' }, [
        el('span', { className: 'label', text: 'end' }),
        endInput,
      ]),
      el('div', { className: 'range-apply' }, [
        el('button', {
          className: 'btn btn-primary',
          text: 'Apply',
          on: {
            click: () => {
              const from = Date.parse(startInput.value);
              const to = Date.parse(endInput.value);
              if (isFinite(from) && isFinite(to)) {
                state.rangeOpen = false;
                setRange(from, to, false);
              }
            },
          },
        }),
      ]),
    ]);

    pop.append(presets, el('div', { className: 'sdivider' }), custom);

    // close on outside click
    setTimeout(() => {
      const onDown = (ev: MouseEvent) => {
        if (!pop.isConnected) {
          document.removeEventListener('mousedown', onDown);
          return;
        }
        const target = ev.target as Node;
        if (!pop.contains(target) && !pop.parentElement?.contains(target)) {
          document.removeEventListener('mousedown', onDown);
          state.rangeOpen = false;
          render();
        }
      };
      document.addEventListener('mousedown', onDown);
    }, 0);

    return pop;
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

    // range: one pill, opening a popover with presets + custom datetimes
    const dateGroup = el('div', { className: 'group range-wrap' }, [
      el('span', { className: 'label', text: 'Range' }),
    ]);

    const pillLabel =
      currentPresetLabel() ?? `${shortStamp(state.startMs)} → ${shortStamp(state.endMs)}`;
    const pill = el('button', { className: state.rangeOpen ? 'chip range-pill on' : 'chip range-pill' }, [
      el('span', { text: pillLabel }),
      el('span', { className: 'caret', text: '▾' }),
    ]);
    pill.addEventListener('click', () => {
      state.rangeOpen = !state.rangeOpen;
      render();
    });
    dateGroup.append(pill);

    if (state.rangeOpen) {
      dateGroup.append(renderRangePop());
    }
    bar.append(dateGroup);

    // bars picker — only on views with a time-bucketed chart
    if (BUCKETED_VIEWS.has(readHash().view)) {
      bar.append(
        el('div', { className: 'group' }, [
          el('span', { className: 'label', text: 'Bars' }),
          renderBucketPicker(() => {
            // re-render the active view with the new width
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }),
        ]),
      );
    }

    // right group, left to right: refresh · LIVE · status/MEM
    const right = el('div', { className: 'group', attrs: { style: 'margin-left:auto' } });
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

    const refreshChip = el('button', {
      className: 'chip refresh-chip',
      title: 'reload this range',
      html:
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="23 4 23 10 17 10"></polyline>' +
        '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
      on: {
        click: () => {
          loadedSignature = null;
          void replan();
        },
      },
    });
    refreshChip.disabled = state.planning || store.progress.running;

    right.append(refreshChip, liveChip);
    if (state.error) {
      right.append(el('span', { className: 'budget', text: `⚠ ${state.error}` }));
    } else if (state.planning) {
      right.append(el('span', { className: 'budget faint', text: 'looking…' }));
    } else if (state.plan && state.plan.files.length === 0) {
      right.append(el('span', { className: 'budget faint', text: 'no data in this range' }));
    } else {
      right.append(el('span', { className: 'budget' })); // filled by updateLoadedText
    }
    bar.append(right);

    container.append(bar);

    // progress thread under the bar
    const progress = el('div', { className: 'progress-thread' });
    const fill = el('div', { className: 'fill' });
    progress.append(fill);
    container.append(progress);
    updateFill(fill);

    // the loaded pill is part of the render, not just a store-event side
    // effect — otherwise any re-render (route change, range fiddling)
    // leaves the budget span empty until the next data event
    updateLoadedText();
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
    if (state.planning || state.error) return; // those states own the text
    const { running, filesTotal, bytesDone } = store.progress;
    const budget = container.querySelector<HTMLElement>('.budget');
    if (!budget || filesTotal === 0) return;
    if (running) {
      const total = state.plan?.totalBytes ?? 0;
      budget.textContent =
        total > 0 ? `loading ${fmtBytes(bytesDone)} of ${fmtBytes(total)}…` : 'loading…';
      return;
    }
    if (store.records.length === 0 && store.files.size === 0) return;
    clearEl(budget);
    const inMemory = [...store.files.values()].reduce((s, f) => s + f.sizeUncompressed, 0);
    const link = document.createElement('a');
    link.href = '#/store';
    link.className = 'store-pill';
    link.title = 'inspect the in-memory store (files, sizes, eviction)';
    link.textContent = `MEM: ${fmtCount(store.records.length)} records · ${fmtBytes(inMemory)}`;
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      setView('/store');
    });
    budget.append(link);
  }

  function clearEl(node: HTMLElement): void {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  activeHashHandler = () => render();
  window.addEventListener('hashchange', activeHashHandler);

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
