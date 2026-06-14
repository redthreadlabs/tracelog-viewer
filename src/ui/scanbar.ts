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
import type { ScanPlan } from '../s3/scanner';
import { intervalSpan } from '../s3/keys';
import { storeClient } from '../data/storeclient';
import { viewState, resetViewState } from '../state';
import { fmtBytesRough } from './format';
import { getParam, setParams, setView, parseWindowParam, windowParam, readHash, RANGE_NAV_EVENT } from './hashstate';
import { renderBucketPicker } from './bucketpicker';
import { profiles } from './profiles';
import { clampByMemory } from '../data/ledger';
import { openMemoryLimitModal } from './memorymodal';

const MB = 1024 * 1024;

interface ScanbarState {
  channels: Map<string, boolean>;
  /** host filter, parallel to channels — discovered per channels+range from
   *  plan.allHosts, reconciled on each replan (the picker UI lands later) */
  hosts: Map<string, boolean>;
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
  { label: 'Last 15 minutes', minutes: 15 },
  { label: 'Last 1 hour', minutes: 60 },
  { label: 'Last 2 hours', minutes: 120 },
  { label: 'Last 3 hours', minutes: 180 },
  { label: 'Last 4 hours', minutes: 240 },
  { label: 'Last 6 hours', minutes: 360 },
  { label: 'Last 12 hours', minutes: 720 },
  { label: 'Last 24 hours', minutes: 1440 },
];

const DAY_PRESETS: { label: string; start: () => number }[] = [
  { label: 'Today', start: () => utcDayStart(0) },
  { label: 'This week', start: () => utcWeekStart() },
  { label: 'Last 7 days', start: () => utcDayStart(6) },
  { label: 'Last 30 days', start: () => utcDayStart(29) },
  { label: 'Last 60 days', start: () => utcDayStart(59) },
  { label: 'Last 90 days', start: () => utcDayStart(89) },
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

/** start of the current UTC week (Monday) */
function utcWeekStart(): number {
  const daysSinceMonday = (new Date().getUTCDay() + 6) % 7;
  return utcDayStart(daysSinceMonday);
}

/** epoch-ms → value for <input type="datetime-local"> (local clock) */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** views whose charts bucket records by time — the bars picker applies */
const BUCKETED_VIEWS = new Set(['/overview', '/metrics']);

// Re-rendering the scanbar (e.g. on profile change) must drop the previous
// instance's listeners and timers.
let activeHashHandler: (() => void) | null = null;
let activeClientListeners: (() => void) | null = null;

/** Drop the live scanbar's listeners (re-render, or leaving the data views). */
export function teardownScanbar(): void {
  if (activeHashHandler) {
    window.removeEventListener('hashchange', activeHashHandler);
    window.removeEventListener(RANGE_NAV_EVENT, activeHashHandler);
  }
  activeHashHandler = null;
  activeClientListeners?.();
  activeClientListeners = null;
}

export function renderScanbar(container: HTMLElement): void {
  teardownScanbar();

  // initial range: a shared URL's precise window wins; else its day params;
  // else today (a placeholder until we auto-detect the latest interval).
  const sharedWindow = parseWindowParam(getParam('w'));
  const fromDay = getParam('from');
  const toDay = getParam('to');
  // a fresh arrival pins no range — that's when we auto-detect the latest
  // interval in the bucket rather than defaulting to a possibly-empty "today"
  const rangePinned = !!(getParam('w') || fromDay || toDay);
  const state: ScanbarState = sharedWindow
    ? {
        channels: new Map(),
        hosts: new Map(),
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
        hosts: new Map(),
        startMs: fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : utcDayStart(0),
        endMs: toDay ? Date.parse(`${toDay}T00:00:00Z`) + DAY_MS - 1 : Date.now(),
        wholeDays: true,
        rangeOpen: false,
        plan: null,
        planning: false,
        live: false,
      };

  const selectedChannels = () =>
    [...state.channels.entries()].filter(([, on]) => on).map(([ch]) => ch);
  const selectedHosts = () =>
    [...state.hosts.entries()].filter(([, on]) => on).map(([h]) => h);

  // the URL's host filter intent, applied once the candidate hosts are known:
  // host=a,b narrows; an absent param = all; host= (empty) = none — like `ch`
  const hostParam = getParam('host');
  let hostsFromUrl: Set<string> | null =
    hostParam === null ? null : new Set(hostParam.split(',').filter(Boolean));

  /** Reconcile the host picker against the plan's candidate hosts: keep prior
   *  toggles, default a newly-seen host on (unless a deep link excludes it),
   *  and drop hosts no longer present in the channels+range. */
  function reconcileHosts(allHosts: string[]): void {
    for (const h of allHosts) {
      if (!state.hosts.has(h)) state.hosts.set(h, !hostsFromUrl || hostsFromUrl.has(h));
    }
    for (const h of [...state.hosts.keys()]) {
      if (!allHosts.includes(h)) state.hosts.delete(h);
    }
    hostsFromUrl = null; // the URL intent is consumed once applied
  }

  /** The host filter for planScan: undefined (all) when every candidate is
   *  selected, else the selected subset ([] = none). Before the first plan
   *  populates the picker, honor the deep-link intent. */
  function hostFilter(): string[] | undefined {
    if (state.hosts.size === 0) return hostsFromUrl ? [...hostsFromUrl] : undefined;
    const sel = selectedHosts();
    return sel.length === state.hosts.size ? undefined : sel;
  }

  /** The `host=` URL param mirroring the selection: null (omit) when all on. */
  function hostUrlParam(): string | null {
    if (state.hosts.size === 0) return hostsFromUrl ? [...hostsFromUrl].join(',') : null;
    const sel = selectedHosts();
    return sel.length === state.hosts.size ? null : sel.join(',');
  }

  // identity of the currently loaded plan, so range fiddling that resolves
  // to the same data doesn't reload, and new data auto-loads at most once
  let loadedSignature: string | null = null;

  function planSignature(plan: ScanPlan): string {
    return plan.files.map((f) => `${f.key}@${f.etag ?? ''}`).join('|');
  }

  storeClient
    .request<string[]>('listChannels')
    .then(async (channels) => {
      // a shared URL's ch=a,b narrows the default all-on selection; an
      // absent param means all-on, and ch= (empty → []) means none
      const fromUrl = getParam('ch')?.split(',').filter(Boolean);
      for (const ch of channels) {
        state.channels.set(ch, !fromUrl || fromUrl.includes(ch));
      }
      // fresh arrival: land on the most recent interval that has data, not
      // a possibly-empty "today"
      if (!rangePinned) {
        const selected = selectedChannels();
        const latest = selected.length
          ? await storeClient.request<string | null>('latestInterval', { channels: selected })
          : null;
        const span = latest ? intervalSpan(latest) : null;
        if (span) {
          state.startMs = span[0];
          state.endMs = Math.min(span[1] - 1, Date.now());
          state.wholeDays = !latest!.includes('T'); // daily interval → whole-day range
        }
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
      // Zero channels selected means "show nothing": empty the store so the
      // views empty too (deselecting *some* channels already does this via
      // the re-scan), and forget the loaded plan so re-selecting reloads.
      // The URL must say so too — `ch=` (empty) is the explicit "none",
      // while an absent param means "all channels" — so a refresh stays
      // empty.
      if (state.channels.size > 0) {
        void storeClient.request('clearStore');
        loadedSignature = null;
        setParams({ ch: '' });
      }
      render();
      return;
    }
    state.planning = true;
    setParams({
      ch: selected.length === state.channels.size ? null : selected.join(','),
      host: hostUrlParam(),
      from: utcDayOf(state.startMs),
      to: utcDayOf(state.endMs),
    });
    render();
    try {
      state.plan = await storeClient.request<ScanPlan>('planScan', {
        channels: selected,
        startMs: state.startMs,
        endMs: state.endMs,
        hosts: hostFilter(),
      });
      reconcileHosts(state.plan.allHosts);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.planning = false;
    // the worker now knows the selection's files — let metadata-served views
    // (the overview Volume chart) render before any records are loaded
    if (state.plan) storeClient.dispatchEvent(new Event('plan'));
    maybeAutoLoad();
    render();
  }

  function maybeAutoLoad(): void {
    if (!state.plan) return;
    if (state.plan.files.length === 0) {
      // A range that matches no files means "show nothing" — same contract
      // as deselecting every channel. Without this, switching to an empty
      // range (e.g. Today before any logs land) silently kept the old data.
      const snap = storeClient.snapshot;
      if (snap.recordCount > 0 || snap.files.length > 0) {
        void storeClient.request('clearStore');
        loadedSignature = null;
      }
      return;
    }
    if (storeClient.snapshot.progress.running) return;
    if (planSignature(state.plan) === loadedSignature) {
      // same data, possibly a different slice of it: apply the window and
      // re-render the views without refetching anything
      applyWindow();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    void runScan();
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

  /**
   * Re-derive the range from the URL and reload if it changed. The browser
   * history IS the zoom stack: brushing the chart pushes a new range entry
   * (RANGE_NAV_EVENT), and Back/Forward restore prior ranges (hashchange).
   * Both land here, so a window zoom and a history step take the same path.
   */
  function syncRangeFromUrl(): void {
    const w = parseWindowParam(getParam('w'));
    const fromDay = getParam('from');
    const toDay = getParam('to');
    let startMs: number;
    let endMs: number;
    let wholeDays: boolean;
    if (w) {
      // a precise sub-day range (a brushed window or a shared deep link)
      [startMs, endMs] = w;
      wholeDays = false;
    } else if (fromDay || toDay) {
      startMs = fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : state.startMs;
      endMs = toDay ? Date.parse(`${toDay}T00:00:00Z`) + DAY_MS - 1 : state.endMs;
      wholeDays = true;
    } else {
      return; // no range in the URL — nothing to sync
    }
    if (startMs === state.startMs && endMs === state.endMs && wholeDays === state.wholeDays) {
      return; // unchanged — don't reload
    }
    setRange(startMs, endMs, wholeDays);
  }

  /** Actually load a plan (no budget check — runScan gates before this). */
  function executePlan(plan: ScanPlan): void {
    loadedSignature = planSignature(plan);
    resetViewState(); // a new scan invalidates any brushed window / deep link
    // hand the worker the active window so it loads overlapping files first
    const window = state.wholeDays ? null : [state.startMs, state.endMs];
    void storeClient.request('executeScan', { plan, window });
    applyWindow();
  }

  /**
   * Load the selected view, but first check its estimated in-memory size
   * against the workspace's memory limit (SPEC §8). Over budget → the
   * guardrail modal (raise the limit / clamp to newest that fits / cancel)
   * instead of loading. No limit set → load straight away.
   */
  async function runScan(): Promise<void> {
    const plan = state.plan;
    if (!plan || plan.files.length === 0) return;

    const limitMb = profiles.active()?.memoryLimitMb;
    if (limitMb == null || limitMb <= 0) {
      executePlan(plan);
      return;
    }
    const limitBytes = limitMb * MB;

    let est: { total: number; perFile: number[] };
    try {
      est = await storeClient.request('estimateView', { files: plan.files });
    } catch {
      executePlan(plan); // estimate unavailable — don't block the user
      return;
    }
    if (est.total <= limitBytes) {
      executePlan(plan);
      return;
    }

    const keep = clampByMemory(plan.files, est.perFile, limitBytes);
    const fitBytes = keep.reduce((sum, i) => sum + (est.perFile[i] ?? 0), 0);
    openMemoryLimitModal({
      estBytes: est.total,
      limitBytes,
      fileCount: plan.files.length,
      fitCount: keep.length,
      fitBytes,
      onRaise: (newLimitMb) => {
        const p = profiles.active();
        if (p) profiles.save({ ...p, memoryLimitMb: newLimitMb });
        executePlan(plan);
      },
      onClamp: () => {
        const files = keep.map((i) => plan.files[i]);
        executePlan({
          files,
          totalBytes: files.reduce((sum, f) => sum + f.size, 0),
          hosts: [...new Set(files.map((f) => f.host))].sort(),
          allHosts: plan.allHosts, // the candidate set is unchanged by clamping
          channels: [...new Set(files.map((f) => f.channel))].sort(),
        });
      },
      // leave the loaded data as-is; forget the signature so re-selecting retries
      onCancel: () => {
        loadedSignature = null;
      },
    });
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
        state.startMs === preset.start() &&
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
      item(preset.label, () => setRange(preset.start(), Date.now(), true));
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
          // live mode watches today: extend the range to include now
          if (state.live && state.endMs < Date.now()) state.endMs = Date.now();
          void storeClient.request('setLive', { on: state.live, channels: selectedChannels() });
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
    refreshChip.disabled = state.planning || storeClient.snapshot.progress.running;

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
    const { filesTotal, filesDone, running } = storeClient.snapshot.progress;
    const pct = filesTotal > 0 ? (filesDone / filesTotal) * 100 : 0;
    fill.style.insetInlineEnd = `${100 - (running || pct > 0 ? pct : 0)}%`;
    if (!running && pct >= 100) {
      setTimeout(() => {
        fill.style.insetInlineEnd = '100%';
      }, 600);
    }
  }

  const onProgress = (): void => {
    const fill = container.querySelector<HTMLElement>('.progress-thread .fill');
    if (fill) updateFill(fill);
    const btn = container.querySelector<HTMLButtonElement>('.btn-primary');
    if (btn) {
      btn.disabled =
        storeClient.snapshot.progress.running || !state.plan || state.plan.files.length === 0;
    }
    updateLoadedText();
  };
  storeClient.addEventListener('progress', onProgress);
  storeClient.addEventListener('data', updateLoadedText);
  activeClientListeners = () => {
    storeClient.removeEventListener('progress', onProgress);
    storeClient.removeEventListener('data', updateLoadedText);
  };

  /** the MEM/loading readout is one pill — same chrome in both states */
  function storePill(text: string, title: string): HTMLAnchorElement {
    const link = document.createElement('a');
    link.href = '#/internals/store';
    link.className = 'store-pill';
    link.title = title;
    link.textContent = text;
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      setView('/internals/store');
    });
    return link;
  }

  function updateLoadedText(): void {
    if (state.planning || state.error) return; // those states own the text
    const { running, filesTotal, bytesDone, bytesTotal } = storeClient.snapshot.progress;
    const budget = container.querySelector<HTMLElement>('.budget');
    if (!budget || filesTotal === 0) return;
    if (running) {
      // the worker reports the working-set total (channels × range, narrowed by
      // any zoom window) — so this denominator shrinks when you zoom in
      const total = bytesTotal;
      clearEl(budget);
      budget.append(
        storePill(
          total > 0 ? `LOADING: ${fmtBytesRough(bytesDone)} of ${fmtBytesRough(total)}` : 'LOADING…',
          'loading — inspect progress in the store inspector',
        ),
      );
      return;
    }
    const snap = storeClient.snapshot;
    if (snap.recordCount === 0 && snap.files.length === 0) return;
    clearEl(budget);
    // the worker can't self-measure its heap (no performance.memory there),
    // so report the decompressed bytes it's holding — a real proxy for it
    const inMemory = snap.files.reduce((s, f) => s + f.sizeUncompressed, 0);
    budget.append(
      storePill(`LOADED: ${fmtBytesRough(inMemory)}`, 'inspect the in-memory store (files, sizes, eviction)'),
    );
  }

  function clearEl(node: HTMLElement): void {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Back/Forward (hashchange) and a chart brush (RANGE_NAV_EVENT) both re-sync
  // the range from the URL, then re-render.
  activeHashHandler = () => {
    syncRangeFromUrl();
    render();
  };
  window.addEventListener('hashchange', activeHashHandler);
  window.addEventListener(RANGE_NAV_EVENT, activeHashHandler);

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
