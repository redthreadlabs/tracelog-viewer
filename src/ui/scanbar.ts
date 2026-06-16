/**
 * The scanbar (SPEC §6.0): channel multi-select populated by discovery, a
 * datetime-range picker with presets, and the download budget — always
 * shown before a scan runs.
 *
 * Granularity note: S3 files are daily, so the listing/fetch is driven by
 * the UTC *days* covering the range; the time-of-day component narrows the
 * viewed range instead (viewState.timeRange — the same mechanism as dragging
 * the chart, encoded in the `r` hash param). Quick presets ("15 min")
 * scan the covering day(s) and narrow to the precise range.
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
import { fmtBytesRough, isUtcMode } from './format';
import { getParam, setParams, pushParams, setView, rangeFromParams, readHash, RANGE_NAV_EVENT } from './hashstate';
import { BUCKET_CHOICES, chosenBucketMs } from './bucketpicker';
import { renderChooser } from './chooser';
import { profiles } from './profiles';
import { clampByMemory } from '../data/ledger';

const MB = 1024 * 1024;

interface ScanbarState {
  channels: Map<string, boolean>;
  /** host filter, parallel to channels — discovered per channels+range from
   *  plan.allHosts, reconciled on each replan (the picker UI lands later) */
  hosts: Map<string, boolean>;
  /** the selected range, epoch-ms (end may be "now" for quick presets) */
  startMs: number;
  endMs: number;
  /** whole-day ranges don't narrow the time range after scanning */
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

/** Internal hint (not a URL concept): a range that begins on a UTC midnight
 *  came from a day-preset, so the picker labels it as such and bars default
 *  coarser. Cleared for any sub-day range (quick presets, custom, drag). */
function isWholeDayRange(startMs: number): boolean {
  return startMs % DAY_MS === 0;
}

/** epoch-ms → value for <input type="datetime-local"> (local clock) */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** views whose charts bucket records by time — the bars picker applies */
const BUCKETED_VIEWS = new Set(['/overview', '/metrics']);

/**
 * Does this view read the in-memory record store? — the gate for loading raw
 * records (SPEC §11, #1b). The overview is served entirely from durable indexes,
 * and the app pages (About/config/internals) need no logs — so neither triggers
 * a working-set load. Everything else (Records, Events, Metrics, Clients,
 * Scanner, and the per-transaction/trace drill-downs) scans records, so opening
 * one loads the working set. (Proactively pre-warming that load — so a drill-down
 * is instant — is the separate #2 prefetch, not built yet.)
 */
function viewNeedsRecords(view: string): boolean {
  if (view === '/overview' || view === '/about' || view === '/config') return false;
  if (view.startsWith('/internals/')) return false;
  return true;
}

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

  // initial range: the URL's from/to (epoch-ms) if present; else today (a
  // placeholder until we auto-detect the latest interval). A fresh arrival
  // pins no range — that's when we auto-detect rather than defaulting to a
  // possibly-empty "today".
  const pinned = rangeFromParams();
  const rangePinned = pinned !== null;
  const state: ScanbarState = {
    channels: new Map(),
    hosts: new Map(),
    startMs: pinned ? pinned[0] : utcDayStart(0),
    endMs: pinned ? pinned[1] : Date.now(),
    wholeDays: pinned ? isWholeDayRange(pinned[0]) : true,
    rangeOpen: false,
    plan: null,
    planning: false,
    live: false,
  };

  const selectedChannels = () =>
    [...state.channels.entries()].filter(([, on]) => on).map(([ch]) => ch);
  const selectedHosts = () =>
    [...state.hosts.entries()].filter(([, on]) => on).map(([h]) => h);

  // the URL's filter intent per picker, applied once the candidate values are
  // known: ch/host=a,b narrows; an absent param = all; an empty value = none
  const parseFilterParam = (name: string): Set<string> | null => {
    const v = getParam(name);
    return v === null ? null : new Set(v.split(',').filter(Boolean));
  };
  let channelsFromUrl = parseFilterParam('ch');
  let hostsFromUrl = parseFilterParam('host');

  /** Reconcile a picker against the candidate values present in the range: keep
   *  prior toggles, default a newly-seen value on (unless a deep link excludes
   *  it), and drop values no longer present. */
  function reconcileFacet(map: Map<string, boolean>, values: string[], fromUrl: Set<string> | null): void {
    for (const v of values) {
      if (!map.has(v)) map.set(v, !fromUrl || fromUrl.has(v));
    }
    for (const v of [...map.keys()]) {
      if (!values.includes(v)) map.delete(v);
    }
  }

  /** Refresh the channel + host candidate sets — the unique values present in
   *  the range — when the range changes. Guarded so a selection-only replan
   *  doesn't re-list. */
  let facetSig: string | null = null;
  async function ensureFacets(): Promise<void> {
    const sig = `${state.startMs}-${state.endMs}`;
    if (sig === facetSig) return;
    const facets = await storeClient.request<{ channels: string[]; hosts: string[] }>('listFacets', {
      startMs: state.startMs,
      endMs: state.endMs,
    });
    reconcileFacet(state.channels, facets.channels, channelsFromUrl);
    reconcileFacet(state.hosts, facets.hosts, hostsFromUrl);
    channelsFromUrl = null; // deep-link intent consumed after first application
    hostsFromUrl = null;
    facetSig = sig;
  }

  /** Open dropdown (one at a time), persisted across re-renders like rangeOpen. */
  let openPicker: 'channels' | 'hosts' | 'bars' | null = null;
  /** the ch/host params when the open picker was opened — so closing it pushes a
   *  single history entry for the whole session (Back undoes it in one step) */
  let pickerSnapshot: { ch: string | null; host: string | null } | null = null;
  /** a toggle happened in the open picker — defer the plan + load until close */
  let pickerDirty = false;

  const selectionParams = (): { ch: string | null; host: string | null } => ({
    ch: channelUrlParam(),
    host: hostUrlParam(),
  });

  /** Open a picker: snapshot the selection so Cancel/tap-away can revert to it.
   *  Leaving another picker open without OK reverts it (strict commit model). */
  function openFacetPicker(id: 'channels' | 'hosts'): void {
    if (openPicker && openPicker !== id) cancelPicker();
    openPicker = id;
    pickerSnapshot = selectionParams();
    pickerDirty = false;
    render();
  }

  /** OK: apply the pending selection — push one history entry, then plan + load. */
  function commitPicker(): void {
    const snap = pickerSnapshot;
    const dirty = pickerDirty;
    openPicker = null;
    pickerSnapshot = null;
    pickerDirty = false;
    if (snap && dirty) {
      commitPickerHistory(snap);
      void replan();
    }
    render();
  }

  /** Cancel / tap-away / Esc: revert to the selection as it was when opened. */
  function cancelPicker(): void {
    if (openPicker && pickerSnapshot) {
      applyUrlSelection(state.channels, pickerSnapshot.ch);
      applyUrlSelection(state.hosts, pickerSnapshot.host);
    }
    openPicker = null;
    pickerSnapshot = null;
    pickerDirty = false;
    render();
  }

  function commitPickerHistory(before: { ch: string | null; host: string | null }): void {
    const after = selectionParams();
    if (after.ch === before.ch && after.host === before.host) return; // no net change
    // the session didn't touch the URL; push `after` as a new entry over the
    // unchanged `before`, so one Back step returns to the pre-open selection
    setParams({ ch: before.ch, host: before.host });
    pushParams({ ch: after.ch, host: after.host });
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

  /** The `ch=` URL param mirroring the selection: null (omit) when all on. */
  function channelUrlParam(): string | null {
    if (state.channels.size === 0) return channelsFromUrl ? [...channelsFromUrl].join(',') : null;
    const sel = selectedChannels();
    return sel.length === state.channels.size ? null : sel.join(',');
  }

  /** Force a picker's on/off to match a URL param (URL = truth on Back/Forward):
   *  null = all on, 'a,b' = those on, '' = none. Returns whether anything moved. */
  function applyUrlSelection(map: Map<string, boolean>, param: string | null): boolean {
    const sel = param === null ? null : new Set(param.split(',').filter(Boolean));
    let changed = false;
    for (const k of map.keys()) {
      const want = !sel || sel.has(k);
      if (map.get(k) !== want) {
        map.set(k, want);
        changed = true;
      }
    }
    return changed;
  }

  // identity of the currently loaded plan, so range fiddling that resolves
  // to the same data doesn't reload, and new data auto-loads at most once
  let loadedSignature: string | null = null;

  function planSignature(plan: ScanPlan): string {
    return plan.files.map((f) => `${f.key}@${f.etag ?? ''}`).join('|');
  }

  storeClient
    .request<string[]>('listChannels')
    .then(async (channelNames) => {
      // fresh arrival: land on the most recent interval that has data, not a
      // possibly-empty "today". The pickers themselves are populated from the
      // range's facets by ensureFacets once we have a range.
      if (!rangePinned) {
        const chf = channelsFromUrl;
        const want = chf ? channelNames.filter((c) => chf.has(c)) : channelNames;
        const detect = want.length ? want : channelNames;
        const latest = await storeClient.request<string | null>('latestInterval', { channels: detect });
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
    // refresh the channel/host candidate sets for the range first, so the
    // selection below (and the zero-channels check) sees the reconciled pickers
    try {
      await ensureFacets();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      render();
      return;
    }
    const selected = selectedChannels();
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
        viewState.overBudget = null;
        setParams({ ch: '' });
      }
      render();
      return;
    }
    state.planning = true;
    setParams({
      ch: channelUrlParam(),
      host: hostUrlParam(),
      from: String(Math.round(state.startMs)),
      to: String(Math.round(state.endMs)),
    });
    render();
    try {
      state.plan = await storeClient.request<ScanPlan>('planScan', {
        channels: selected,
        startMs: state.startMs,
        endMs: state.endMs,
        hosts: hostFilter(),
      });
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.planning = false;
    // the worker now knows the selection's files — let metadata-served views
    // (the overview Volume chart) render before any records are loaded
    if (state.plan) storeClient.dispatchEvent(new Event('plan'));
    // never auto-load while a picker is open — the user is still choosing; the
    // load fires when they close it (setOpenPicker)
    if (!openPicker) void maybeAutoLoad();
    render();
  }

  async function maybeAutoLoad(): Promise<void> {
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
    const view = readHash().view;
    // App pages (About/config/internals) read no logs → never load.
    if (view !== '/overview' && !viewNeedsRecords(view)) {
      applyRange();
      return;
    }

    // The overview is served from durable indexes. When they cover this
    // range+grid it renders instantly AND we PREFETCH the working set in the
    // background (throttled) so a drill-down is ready — the same load a record
    // view would do, just started early and at low priority. When they can't
    // cover it (cold range / sub-hour bars / missing index) the overview itself
    // needs the scan, so that runs foreground.
    const isOverview = view === '/overview';
    const indexed = isOverview
      ? await storeClient.request<boolean>('overviewIndexed', {
          range: [state.startMs, state.endMs],
          bucketMs: chosenBucketMs(),
          utc: isUtcMode(),
        })
      : false;

    // every data view reflects the new range — even while a load is in flight
    // (the overview renders from the index regardless of the store's state)
    applyRange();
    if (isOverview) storeClient.dispatchEvent(new Event('plan'));

    if (planSignature(state.plan) === loadedSignature) {
      // same files already loaded, a different slice — re-render, no refetch
      if (!isOverview) window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    // A new plan — even if a load is already running. We must re-scope the loader
    // to it (setPlan is additive: keeps loaded records, drops the now-out-of-plan
    // PENDING fetches), or a brush-narrow mid-prefetch would let the loader keep
    // pursuing the old, wider plan to completion. runScan also (re)sets the load
    // priority, so the prefetch stays throttled.
    void runScan({ background: isOverview && indexed });
  }

  /** The view is the range: every view narrows to [start, end]. (For a
   *  whole-day range that equals the loaded data, so it's a no-op there.) */
  function applyRange(): void {
    viewState.timeRange = [state.startMs, state.endMs];
  }

  function setRange(startMs: number, endMs: number, wholeDays: boolean): void {
    state.startMs = startMs;
    state.endMs = Math.max(endMs, startMs + 60_000);
    state.wholeDays = wholeDays;
    void replan();
  }

  /**
   * Re-derive the whole working set from the URL — range AND selection — and
   * reload if anything changed. The browser history IS the navigation stack:
   * dragging the chart pushes a range entry, closing a picker pushes a selection
   * entry, and Back/Forward restore prior states (hashchange). All land here, so
   * a range change, a filter change, and a history step take the same path.
   */
  async function syncFromUrl(): Promise<void> {
    let changed = false;

    // range — from/to (epoch-ms) are the whole story
    const r = rangeFromParams();
    let startMs = state.startMs;
    let endMs = state.endMs;
    let wholeDays = state.wholeDays;
    if (r) {
      [startMs, endMs] = r;
      wholeDays = isWholeDayRange(startMs);
    }
    if (startMs !== state.startMs || endMs !== state.endMs || wholeDays !== state.wholeDays) {
      state.startMs = startMs;
      state.endMs = endMs;
      state.wholeDays = wholeDays;
      facetSig = null; // range changed → refresh the candidate keys
      changed = true;
    }

    // selection — apply after ensureFacets has the candidate keys for the range
    await ensureFacets();
    changed = applyUrlSelection(state.channels, getParam('ch')) || changed;
    changed = applyUrlSelection(state.hosts, getParam('host')) || changed;

    if (changed) {
      void replan(); // re-plans + (per view) loads via maybeAutoLoad
    } else {
      render(); // re-renders the scanbar pill (the over-budget warning is per-view)
      ensureLoadForView(); // a record view we just landed on, not yet loaded → load
      updateLoadPriority(); // an in-flight prefetch → match it to the new view
    }
  }

  /** Load the working set if a record-needing view isn't loaded — the
   *  load-on-entry for a view nav. The overview's prefetch covers the rest. */
  function ensureLoadForView(): void {
    if (!state.plan || state.plan.files.length === 0) return;
    if (storeClient.snapshot.progress.running) return;
    if (planSignature(state.plan) === loadedSignature) return; // already loaded
    if (!viewNeedsRecords(readHash().view)) return; // index-served → no load
    void runScan({ background: false });
  }

  /** Match an in-flight load's priority to the active view: a record view waits
   *  on it (foreground), an index-served view only prefetches (background). Same
   *  plan, so this never re-loads — it just changes the in-flight cap. */
  function updateLoadPriority(): void {
    if (!storeClient.snapshot.progress.running) return;
    void storeClient.request('setLoadPriority', {
      background: !viewNeedsRecords(readHash().view),
    });
  }

  /** Actually load a plan (no budget check — runScan gates before this).
   *  `background` starts it throttled (a prefetch) — see runScan. */
  function executePlan(plan: ScanPlan, background: boolean): void {
    loadedSignature = planSignature(plan);
    resetViewState(); // a new scan invalidates any prior range / deep link
    // hand the worker the active range so it loads overlapping files first
    const range = [state.startMs, state.endMs];
    void storeClient.request('executeScan', { plan, range, background });
    applyRange();
  }

  /**
   * Load the selected view, bounded by the workspace memory limit (SPEC §8).
   * Over budget is a STATE, not a gate: we load the newest files that fit and
   * surface an over-budget indicator. The user resolves it by narrowing any
   * dimension (channels/hosts/range — the lever that matches their cause),
   * going Back, or raising the limit. No limit set → load it all.
   */
  function runScan(opts: { background: boolean }): void {
    const plan = state.plan;
    if (!plan || plan.files.length === 0) return;

    const limitMb = profiles.active()?.memoryLimitMb;
    if (limitMb == null || limitMb <= 0) {
      viewState.overBudget = null;
      executePlan(plan, opts.background);
      return;
    }
    const limitBytes = limitMb * MB;

    // budget in COMPRESSED bytes — the listing's per-file size, exact and free
    // (no sidecar). It proxies record heap (SPEC §8 / MEMORY_MANAGEMENT_GOTCHAS).
    const perFile = plan.files.map((f) => f.size);
    const total = perFile.reduce((sum, b) => sum + b, 0);
    if (total <= limitBytes) {
      viewState.overBudget = null;
      executePlan(plan, opts.background);
      return;
    }

    // over budget: load the newest files that fit (a prefetch warms only what
    // fits, silently — the amber pill surfaces only on a record view, where the
    // clamp bites; the chart already blanks un-loaded intervals).
    const keep = clampByMemory(plan.files, perFile, limitBytes);
    const files = keep.map((i) => plan.files[i]);
    viewState.overBudget = { estBytes: total };
    executePlan(
      {
        files,
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        hosts: [...new Set(files.map((f) => f.host))].sort(),
        allHosts: plan.allHosts, // the candidate set is unchanged by clamping
        channels: [...new Set(files.map((f) => f.channel))].sort(),
      },
      opts.background,
    );
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

  /** A channel/host pill-dropdown over the range's candidate values. */
  function facetPicker(
    label: string,
    id: 'channels' | 'hosts',
    map: Map<string, boolean>,
  ): HTMLElement {
    const values = [...map.keys()].sort();
    const selected = new Set(values.filter((v) => map.get(v)));
    return renderChooser({
      label,
      mode: 'multi',
      values,
      selected,
      open: openPicker === id,
      onOpen: () => openFacetPicker(id),
      onCommit: () => commitPicker(),
      onCancel: () => cancelPicker(),
      onChange: (sel) => {
        // edit locally — checkboxes + summary update at once, but plan + load
        // (and the history entry) wait for OK; Cancel/tap-away/Esc revert
        for (const v of map.keys()) map.set(v, sel.has(v));
        pickerDirty = true;
        render();
      },
    });
  }

  /** The bar-width chooser — single-select: picking a width applies and closes
   *  immediately (no OK/Cancel). Lives in the `b` hash param like everything. */
  function bucketChooser(): HTMLElement {
    const tokens = BUCKET_CHOICES.map((c) => c.token);
    const current = getParam('b');
    const value = current && tokens.includes(current) ? current : 'auto';
    return renderChooser({
      label: 'Bars',
      mode: 'single',
      values: tokens,
      selected: new Set([value]),
      open: openPicker === 'bars',
      labelOf: (t) => BUCKET_CHOICES.find((c) => c.token === t)?.label ?? t,
      onOpen: () => {
        if (openPicker === 'channels' || openPicker === 'hosts') cancelPicker();
        openPicker = 'bars';
        render();
      },
      onChange: (sel) => {
        const token = [...sel][0] ?? 'auto';
        openPicker = null;
        setParams({ b: token === 'auto' ? null : token });
        render(); // close the popover
        window.dispatchEvent(new HashChangeEvent('hashchange')); // re-render the chart
      },
      onCancel: () => {
        openPicker = null;
        render();
      },
    });
  }

  function render(): void {
    clear(container);
    const bar = el('div', { className: 'scanbar' });

    // channels + hosts: pill-dropdown multiselects over the range's facets
    bar.append(facetPicker('Channels', 'channels', state.channels));
    bar.append(facetPicker('Hosts', 'hosts', state.hosts));

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

    // bars chooser — only on views with a time-bucketed chart
    if (BUCKETED_VIEWS.has(readHash().view)) {
      bar.append(bucketChooser());
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

    // the loaded pill is part of the render, not just a store-event side
    // effect — otherwise any re-render (route change, range fiddling)
    // leaves the budget span empty until the next data event
    updateLoadedText();
  }

  const onProgress = (): void => {
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
      // report COMPRESSED bytes — the memory-budget currency (the heap proxy).
      // The denominator is the working set's compressed size and shrinks when you
      // narrow the range.
      clearEl(budget);
      budget.append(
        storePill(
          bytesTotal > 0
            ? `LOADING: ${fmtBytesRough(bytesDone)} of ${fmtBytesRough(bytesTotal)}`
            : 'LOADING…',
          'loading — inspect progress in the store inspector',
        ),
      );
      return;
    }
    const snap = storeClient.snapshot;
    if (snap.recordCount === 0 && snap.files.length === 0) return;
    clearEl(budget);
    // compressed bytes held — the heap proxy the memory limit is denominated in
    const inMemory = snap.files.reduce((s, f) => s + f.sizeCompressed, 0);
    // the over-budget warning surfaces only where the clamp actually bites — a
    // record-reading view. The index-served overview is complete from the cube
    // even when the prefetch loaded only the newest slice, so it shows plain
    // LOADED there (the prefetch warms what fits, silently).
    if (viewState.overBudget && viewNeedsRecords(readHash().view)) {
      // we loaded the newest slice that fits — tap through to the store inspector
      // (the memory page) to adjust the budget; narrowing a filter or Back also
      // resolve it. Same target as the LOADED pill, so internals stays reachable.
      const pill = storePill(
        `over budget · ${fmtBytesRough(inMemory)} / ${fmtBytesRough(viewState.overBudget.estBytes)}`,
        'showing the newest data that fits — tap for the store inspector to raise the budget (or narrow a filter / go back)',
      );
      pill.classList.add('over-budget');
      budget.append(pill);
      return;
    }
    budget.append(
      storePill(`LOADED: ${fmtBytesRough(inMemory)}`, 'inspect the in-memory store (files, sizes, eviction)'),
    );
  }

  function clearEl(node: HTMLElement): void {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Back/Forward (hashchange), a chart brush, and a picker close (RANGE_NAV_EVENT)
  // all re-derive the working set from the URL.
  activeHashHandler = () => {
    void syncFromUrl();
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
