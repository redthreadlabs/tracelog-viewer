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
import { PERIOD_CHOICES, chosenPeriodMs } from './periodpicker';
import { renderChooser } from './chooser';
import { profiles } from './profiles';
import { clampByMemory } from '../data/ledger';
import {
  resolveRange,
  rangeToken,
  parseRangeToken,
  rangeLabel,
  TIME_UNITS,
  NAMED_RANGES,
  type RangeSpec,
  type TimeUnit,
} from './range';
import { loadRecents, pushRecent } from './recents';

const MB = 1024 * 1024;

interface ScanbarState {
  channels: Map<string, boolean>;
  /** host filter, parallel to channels — discovered per channels+range from
   *  plan.allHosts, reconciled on each replan (the picker UI lands later) */
  hosts: Map<string, boolean>;
  /** the RESOLVED range, epoch-ms. For a relative spec these slide as time
   *  passes; for an absolute range they're fixed. */
  startMs: number;
  endMs: number;
  /** the active relative spec (rolling "last N" or named), or null when the
   *  range is an explicit absolute window. The source of truth for the URL
   *  `range=` token and the auto-refresh. */
  rangeSpec: RangeSpec | null;
  /** whole-day ranges don't narrow the time range after scanning */
  wholeDays: boolean;
  rangeOpen: boolean;
  plan: ScanPlan | null;
  planning: boolean;
  /** the user froze the live view (Pause). LIVE itself is DERIVED — it's on
   *  whenever the window intersects the open `_current` interval and a fresh host
   *  exists; `paused` is the only manual lever, freezing the slide + the fetch.
   *  Reset by a range change (fresh intent to watch). */
  paused: boolean;
  /** is there a fresh `_current` host in the selected channels? — a prerequisite
   *  for LIVE. False on a finalized-only bucket (SPEC §6.0). */
  liveAvailable: boolean;
  /** 'current' = track the live host set dynamically ("all current"); else a
   *  manual host subset. */
  hostMode: 'manual' | 'current';
  /** the resolved live host set (from liveStatus) — the working set in 'current'
   *  mode, re-resolved as hosts come and go */
  currentHosts: string[];
  error?: string;
}

/** Host sentinel meaning "track the live set" (no host is named `*…`). */
const HOST_CURRENT = '*current';

const DAY_MS = 86_400_000;

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

/** Internal hint (not a URL concept): a day-aligned range labels coarser and
 *  bars default coarser. True for absolute ranges starting on a UTC midnight,
 *  and for relative specs that are day-granular (see specWholeDays). */
function isWholeDayRange(startMs: number): boolean {
  return startMs % DAY_MS === 0;
}

/** Whether a relative spec is day-granular (named, or last-N-days/weeks/months). */
function specWholeDays(spec: RangeSpec): boolean {
  return spec.kind === 'named' || spec.unit === 'days' || spec.unit === 'weeks' || spec.unit === 'months';
}

/** Whether the spec is an "until now" range — every `last N`, plus the named
 *  ranges that end at now (today / this-week / this-month). The closed-past ones
 *  (yesterday / last-week / last-month) and absolute ranges are not. */
function nowEnding(spec: RangeSpec | null): boolean {
  if (!spec) return false;
  if (spec.kind === 'last') return true;
  return spec.name === 'today' || spec.name === 'this-week' || spec.name === 'this-month';
}

/** epoch-ms → value for <input type="datetime-local"> (local clock) */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** views whose charts aggregate records by time — the period picker applies */
const PERIOD_VIEWS = new Set(['/overview', '/metrics']);

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
// instance's listeners and handles.
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

  // This instance's liveness. renderScanbar kicks off async work (listChannels →
  // replan → start the auto-refresh timers) that can resolve AFTER a re-mount has
  // already torn this instance down — at which point its timers wouldn't yet have
  // existed to be cleared, so they'd escape cleanup and keep rendering/​LISTing
  // against the shared scanbar host (clobbering the live instance, e.g. flipping a
  // paused chip back to LIVE). Teardown sets this; every async continuation bails.
  let disposed = false;

  // initial range: a relative `range=` token (re-resolved now) wins; else the
  // URL's from/to (absolute); else today (a placeholder until we auto-detect the
  // latest interval). A fresh arrival pins nothing — that's when we auto-detect.
  const initialSpec = parseRangeToken(getParam('range'));
  const pinned = initialSpec ? resolveRange(initialSpec, Date.now(), isUtcMode()) : rangeFromParams();
  const rangePinned = pinned !== null;
  const state: ScanbarState = {
    channels: new Map(),
    hosts: new Map(),
    startMs: pinned ? pinned[0] : utcDayStart(0),
    endMs: pinned ? pinned[1] : Date.now(),
    rangeSpec: initialSpec,
    wholeDays: initialSpec ? specWholeDays(initialSpec) : pinned ? isWholeDayRange(pinned[0]) : true,
    rangeOpen: false,
    plan: null,
    planning: false,
    paused: false,
    liveAvailable: false,
    hostMode: getParam('host') === HOST_CURRENT ? 'current' : 'manual',
    currentHosts: [],
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
  // the `*current` sentinel is a mode, not a host list — no manual pre-selection
  let hostsFromUrl = getParam('host') === HOST_CURRENT ? null : parseFilterParam('host');

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

  /** Refresh the live gate + resolved current-host set for the selected channels
   *  (depends on the channel set, not the range). Channel-sig-guarded so range
   *  drags don't re-LIST, unless `force` (the "all current" tracker, where host
   *  membership changes with channels fixed). Returns whether the live set moved. */
  let liveStatusSig: string | null = null;
  async function refreshLiveStatus(force = false): Promise<boolean> {
    const channels = selectedChannels();
    const sig = [...channels].sort().join(',');
    if (!force && sig === liveStatusSig) return false;
    liveStatusSig = sig;
    if (channels.length === 0) {
      state.liveAvailable = false;
      const moved = state.currentHosts.length > 0;
      state.currentHosts = [];
      syncLiveWatch(); // availability changed → re-derive live
      return moved;
    }
    try {
      const st = await storeClient.request<{ available: boolean; hosts: string[] }>('liveStatus', {
        channels,
      });
      state.liveAvailable = st.available;
      const moved = !sameStrings(state.currentHosts, st.hosts);
      state.currentHosts = st.hosts;
      syncLiveWatch(); // availability resolved (async) → engage/disengage live
      render();
      return moved;
    } catch {
      return false; // transient — the next replan / tick retries
    }
  }
  // Live is DERIVED (relevant = window ∩ open interval + fresh host), so a single
  // stale availability reading just re-derives on the next probe — it self-heals.
  // The user's only lever is Pause, which never fights the relevance logic.

  // ---- "all current" dynamic membership ----
  // While LIVE + "all current", periodically re-resolve the live host set (a
  // discovery LIST) and, when it changes, update the worker's watch set and the
  // working set. Cadence ~ the live tick; phase 3's per-host timers refine this.
  let currentHandle: ReturnType<typeof setInterval> | null = null;
  const CURRENT_TRACK_MS = 30_000;
  function startCurrentTracking(): void {
    if (currentHandle || disposed) return;
    currentHandle = setInterval(() => {
      void (async () => {
        if (state.paused) return; // frozen — don't re-resolve membership or replan
        if (await refreshLiveStatus(true)) {
          pushLiveHosts();
          void replan(); // re-scope the working set to the new live host set
        }
      })();
    }, CURRENT_TRACK_MS);
  }
  function stopCurrentTracking(): void {
    if (currentHandle) clearInterval(currentHandle);
    currentHandle = null;
  }

  /** Is live data relevant to the current view? — the window intersects an open
   *  `_current` interval (so an append, even a back-dated one, could land in it)
   *  AND a fresh host exists. Derived, not chosen: this is what makes the LIVE
   *  chip a status, not a toggle. The open interval is the current UTC day. */
  function liveRelevant(): boolean {
    if (!state.liveAvailable) return false;
    const dayStart = utcDayStart(0);
    return state.startMs < dayStart + DAY_MS && state.endMs > dayStart;
  }

  /** Live is actually running when it's relevant and the user hasn't paused. */
  function effectiveLive(): boolean {
    return liveRelevant() && !state.paused;
  }

  /** Push the active watch set to the worker's live updater (idempotent). */
  function pushLiveHosts(): void {
    void storeClient.request('setLive', {
      on: effectiveLive(),
      channels: selectedChannels(),
      hosts: hostFilter(),
    });
  }

  /** Drive the live updater + the dynamic tracker from the DERIVED live state —
   *  called after a (re)plan, when availability resolves, and on Pause/Resume. */
  function syncLiveWatch(): void {
    if (effectiveLive()) {
      pushLiveHosts();
      if (state.hostMode === 'current') startCurrentTracking();
      else stopCurrentTracking();
    } else {
      pushLiveHosts(); // setLive(off) — stop fetching while paused / historical
      stopCurrentTracking();
    }
  }

  /** Open dropdown (one at a time), persisted across re-renders like rangeOpen. */
  let openPicker: 'channels' | 'hosts' | 'period' | null = null;
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
      applyHostParam(pickerSnapshot.host);
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
    // the resolved live set; if nothing's live (e.g. a finalized-only bucket via
    // a deep link), fall back to all rather than showing empty
    if (state.hostMode === 'current') return state.liveAvailable ? state.currentHosts : undefined;
    if (state.hosts.size === 0) return hostsFromUrl ? [...hostsFromUrl] : undefined;
    const sel = selectedHosts();
    return sel.length === state.hosts.size ? undefined : sel;
  }

  /** The `host=` URL param mirroring the selection: null (omit) when all on,
   *  the `*current` sentinel in "all current" mode. */
  function hostUrlParam(): string | null {
    if (state.hostMode === 'current') return HOST_CURRENT;
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

  /** Apply a `host=` value (URL = truth on Back/Forward/commit): the `*current`
   *  sentinel switches to "all current" mode; anything else is manual with that
   *  subset. Returns whether anything moved. */
  function applyHostParam(param: string | null): boolean {
    if (param === HOST_CURRENT) {
      const moved = state.hostMode !== 'current';
      state.hostMode = 'current';
      return moved;
    }
    const moved = state.hostMode !== 'manual';
    state.hostMode = 'manual';
    return applyUrlSelection(state.hosts, param) || moved;
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
      if (disposed) return; // torn down before the channel list arrived
      void replan();
    })
    .catch((err) => {
      state.error = err instanceof Error ? err.message : String(err);
      render();
    });

  async function replan(): Promise<void> {
    if (disposed) return; // torn down — don't LIST / setLive / paint on a dead instance
    // refresh the channel/host candidate sets for the range first, so the
    // selection below (and the zero-channels check) sees the reconciled pickers
    try {
      await ensureFacets();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      render();
      return;
    }
    // gate LIVE + resolve the current-host set; awaited in "all current" mode so
    // the plan below filters to the live set
    if (state.hostMode === 'current') await refreshLiveStatus();
    else void refreshLiveStatus();
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
    // a relative range lives as `range=<token>` (no from/to); an absolute range
    // as from/to (no range) — the resolved window is ephemeral, not in the URL
    const rangeParams = state.rangeSpec
      ? { range: rangeToken(state.rangeSpec), from: null, to: null }
      : {
          range: null,
          from: String(Math.round(state.startMs)),
          to: String(Math.round(state.endMs)),
        };
    setParams({ ch: channelUrlParam(), host: hostUrlParam(), ...rangeParams });
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
    syncLiveWatch(); // keep the live updater's watch set in step with the selection
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

    // Ask the load planner whether the overview can render this range+grid
    // WITHOUT the working set; if so it renders instantly and we PREFETCH the
    // records in the background (throttled) so a drill-down is warm — the same
    // load a record view would do, just early + low-priority. If not, the
    // overview needs the records, so the scan runs foreground. (Whether an index
    // or a scan ultimately serves it is the solver's business, not ours.)
    const isOverview = view === '/overview';
    const selfServes = isOverview
      ? await storeClient.request<boolean>('overviewSelfServes', {
          range: [state.startMs, state.endMs],
          periodMs: chosenPeriodMs(),
          utc: isUtcMode(),
        })
      : false;

    // every data view reflects the new range — even while a load is in flight
    // (the overview can render before the store fills)
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
    void runScan({ background: isOverview && selfServes });
  }

  /** The view is the range: every view narrows to [start, end]. (For a
   *  whole-day range that equals the loaded data, so it's a no-op there.) */
  function applyRange(): void {
    viewState.timeRange = [state.startMs, state.endMs];
  }

  /** Apply an ABSOLUTE window (custom Apply, a recents entry). Clears any
   *  relative spec and stops the auto-refresh. */
  function setRange(startMs: number, endMs: number, wholeDays: boolean): void {
    state.rangeSpec = null;
    state.paused = false; // a range change is fresh intent → resume
    stopRelativeRefresh();
    state.startMs = startMs;
    state.endMs = Math.max(endMs, startMs + 60_000);
    state.wholeDays = wholeDays;
    void replan();
  }

  /** Apply a RELATIVE spec (a "last N", a named range, or a recents entry):
   *  resolve it now, plan, and start the auto-refresh that keeps it sliding. */
  function applySpec(spec: RangeSpec): void {
    state.rangeSpec = spec;
    state.paused = false; // a range change is fresh intent → resume
    const [s, e] = resolveRange(spec, Date.now(), isUtcMode());
    state.startMs = s;
    state.endMs = e;
    state.wholeDays = specWholeDays(spec);
    pushRecent({ kind: 'spec', spec });
    void replan();
    startRelativeRefresh();
  }

  // ---- auto-refresh: keep a relative range sliding with the wall clock ----
  // A ~30 s tick re-resolves the spec. When the covering UTC days are unchanged
  // (the common case) it just re-windows in place — no LIST, no refetch, no
  // history entry. Only a day rollover (covering days changed) replans.
  let relativeHandle: ReturnType<typeof setInterval> | null = null;
  const RELATIVE_REFRESH_MS = 30_000;
  const coveringSig = (a: number, b: number): string => `${utcDayOf(a)}..${utcDayOf(b)}`;

  function startRelativeRefresh(): void {
    if (relativeHandle || !state.rangeSpec || state.paused || disposed) return; // never slide while paused / torn down
    relativeHandle = setInterval(() => {
      if (!state.rangeSpec) return stopRelativeRefresh();
      if (state.paused) return; // frozen for inspection — don't slide
      const before = coveringSig(state.startMs, state.endMs);
      const [s, e] = resolveRange(state.rangeSpec, Date.now(), isUtcMode());
      if (s === state.startMs && e === state.endMs) return; // no movement (e.g. yesterday)
      state.startMs = s;
      state.endMs = e;
      if (coveringSig(s, e) !== before) void replan(); // day rollover → load new files
      else softRefreshView(); // slid within the same days → re-window only
    }, RELATIVE_REFRESH_MS);
  }
  function stopRelativeRefresh(): void {
    if (relativeHandle) clearInterval(relativeHandle);
    relativeHandle = null;
  }

  /** Re-window the active view to the resolved range without a replan/refetch or
   *  a history entry: update viewState.timeRange and nudge the view to re-query
   *  from already-loaded data + indexes ('plan' for the overview, 'data' else —
   *  the signals each view re-renders on; neither re-triggers syncFromUrl). */
  function softRefreshView(): void {
    applyRange();
    const ev = readHash().view === '/overview' ? 'plan' : 'data';
    storeClient.dispatchEvent(new Event(ev));
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

    // range — a relative `range=` token or absolute from/to
    const spec = parseRangeToken(getParam('range'));
    const specChanged = tokenOf(state.rangeSpec) !== tokenOf(spec);
    // While PAUSED on the same relative spec, the window is FROZEN: a stray
    // hashchange (navigation, a filter change) must not re-resolve it to `now`
    // — that would slide the view and look like an un-pause. Only a genuinely
    // different range (specChanged) re-resolves and resumes.
    const frozen = state.paused && !specChanged && !!spec;
    const r = frozen ? null : spec ? resolveRange(spec, Date.now(), isUtcMode()) : rangeFromParams();
    let startMs = state.startMs;
    let endMs = state.endMs;
    let wholeDays = state.wholeDays;
    if (r) {
      [startMs, endMs] = r;
      wholeDays = spec ? specWholeDays(spec) : isWholeDayRange(startMs);
    }
    state.rangeSpec = spec;
    if (specChanged) {
      state.paused = false; // a genuinely different range resumes (incl. a brush)
      if (spec) startRelativeRefresh();
      else stopRelativeRefresh();
    }
    if (
      startMs !== state.startMs ||
      endMs !== state.endMs ||
      wholeDays !== state.wholeDays ||
      specChanged
    ) {
      state.startMs = startMs;
      state.endMs = endMs;
      state.wholeDays = wholeDays;
      facetSig = null; // range changed → refresh the candidate keys
      changed = true;
    }

    // selection — apply after ensureFacets has the candidate keys for the range
    await ensureFacets();
    changed = applyUrlSelection(state.channels, getParam('ch')) || changed;
    changed = applyHostParam(getParam('host')) || changed;

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


  function renderRangePop(): HTMLElement {
    const pop = el('div', { className: 'range-pop' });

    // LEFT: recently-used ranges (re-read from localStorage on each open)
    const left = el('div', { className: 'range-presets' }, [
      el('div', { className: 'label scol-title', text: 'Recent' }),
    ]);
    const recents = loadRecents();
    if (recents.length === 0) {
      left.append(el('div', { className: 'faint range-recent-empty', text: 'none yet' }));
    }
    for (const r of recents) {
      const label =
        r.kind === 'spec' ? rangeLabel(r.spec) : `${shortStamp(r.from)} → ${shortStamp(r.to)}`;
      left.append(
        el('button', {
          className: 'range-preset',
          text: label,
          on: {
            click: () => {
              state.rangeOpen = false;
              if (r.kind === 'spec') applySpec(r.spec);
              else {
                pushRecent(r); // move to front
                setRange(r.from, r.to, isWholeDayRange(r.from));
              }
            },
          },
        }),
      );
    }

    // RIGHT: LAST [n] [unit], a named-range dropdown, then Custom
    const curLast = state.rangeSpec?.kind === 'last' ? state.rangeSpec : null;
    const amountInput = el('input', {
      className: 'input mono range-last-amount',
      attrs: { type: 'text', inputmode: 'decimal', value: curLast ? String(curLast.amount) : '1' },
    }) as HTMLInputElement;
    const unitSel = el('select', { className: 'input range-unit' }) as HTMLSelectElement;
    for (const u of TIME_UNITS) {
      const opt = el('option', { text: u, attrs: { value: u } }) as HTMLOptionElement;
      if (u === (curLast?.unit ?? 'hours')) opt.selected = true;
      unitSel.append(opt);
    }
    const applyLast = (): void => {
      const n = parseFloat(amountInput.value);
      if (n > 0 && isFinite(n)) {
        state.rangeOpen = false;
        applySpec({ kind: 'last', amount: n, unit: unitSel.value as TimeUnit });
      }
    };
    amountInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') applyLast();
    });
    unitSel.addEventListener('change', applyLast);

    const namedSel = el('select', { className: 'input range-named' }) as HTMLSelectElement;
    namedSel.append(el('option', { text: 'Named…', attrs: { value: '' } }));
    for (const n of NAMED_RANGES) {
      const opt = el('option', { text: n.label, attrs: { value: n.name } }) as HTMLOptionElement;
      if (state.rangeSpec?.kind === 'named' && state.rangeSpec.name === n.name) opt.selected = true;
      namedSel.append(opt);
    }
    namedSel.addEventListener('change', () => {
      if (!namedSel.value) return;
      state.rangeOpen = false;
      applySpec({ kind: 'named', name: namedSel.value as (typeof NAMED_RANGES)[number]['name'] });
    });

    const startInput = datetimeInput(state.startMs, () => {});
    const endInput = datetimeInput(state.endMs, () => {});
    const right = el('div', { className: 'range-custom-col' }, [
      el('div', { className: 'range-field range-last-row' }, [
        el('span', { className: 'label', text: 'Last' }),
        amountInput,
        unitSel,
      ]),
      el('div', { className: 'range-field range-or-row' }, [
        el('span', { className: 'label', text: 'or' }),
        namedSel,
      ]),
      el('div', { className: 'range-divider-h' }),
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
                pushRecent({ kind: 'absolute', from, to });
                setRange(from, to, false);
              }
            },
          },
        }),
      ]),
    ]);

    pop.append(left, el('div', { className: 'sdivider' }), right);

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
      // hosts only: a leading "all current" mode-row, shown when something's live
      special:
        id === 'hosts' && state.liveAvailable
          ? {
              label: 'all current (live)',
              active: state.hostMode === 'current',
              title: 'track the hosts currently uploading live logs — updates as hosts come and go',
              onToggle: () => {
                state.hostMode = state.hostMode === 'current' ? 'manual' : 'current';
                pickerDirty = true;
                render();
              },
            }
          : undefined,
      onOpen: () => openFacetPicker(id),
      onCommit: () => commitPicker(),
      onCancel: () => cancelPicker(),
      onChange: (sel) => {
        // edit locally — checkboxes + summary update at once, but plan + load
        // (and the history entry) wait for OK; Cancel/tap-away/Esc revert
        for (const v of map.keys()) map.set(v, sel.has(v));
        if (id === 'hosts') state.hostMode = 'manual'; // picking a host exits "all current"
        pickerDirty = true;
        render();
      },
    });
  }

  /** The period chooser — single-select: picking a width applies and closes
   *  immediately (no OK/Cancel). Lives in the `period` hash param like everything. */
  function periodChooser(): HTMLElement {
    const tokens = PERIOD_CHOICES.map((c) => c.token);
    const current = getParam('period');
    const value = current && tokens.includes(current) ? current : 'auto';
    return renderChooser({
      label: 'Period',
      mode: 'single',
      values: tokens,
      selected: new Set([value]),
      open: openPicker === 'period',
      labelOf: (t) => PERIOD_CHOICES.find((c) => c.token === t)?.label ?? t,
      onOpen: () => {
        if (openPicker === 'channels' || openPicker === 'hosts') cancelPicker();
        openPicker = 'period';
        render();
      },
      onChange: (sel) => {
        const token = [...sel][0] ?? 'auto';
        openPicker = null;
        setParams({ period: token === 'auto' ? null : token });
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
    if (disposed) return; // a torn-down instance must never paint the shared host
    clear(container);
    const bar = el('div', { className: 'scanbar' });

    // channels + hosts: pill-dropdown multiselects over the range's facets
    bar.append(facetPicker('Channels', 'channels', state.channels));
    bar.append(facetPicker('Hosts', 'hosts', state.hosts));

    // range: one pill, opening a popover with presets + custom datetimes
    const dateGroup = el('div', { className: 'group range-wrap' }, [
      el('span', { className: 'label', text: 'Range' }),
    ]);

    const pillLabel = state.rangeSpec
      ? rangeLabel(state.rangeSpec)
      : `${shortStamp(state.startMs)} → ${shortStamp(state.endMs)}`;
    // an "until now" range gets the same live-red treatment as the LIVE pill —
    // a visual cue that the window tracks the present
    const pillClass =
      'chip range-pill' +
      (state.rangeOpen ? ' on' : '') +
      (nowEnding(state.rangeSpec) ? ' now' : '');
    const pill = el('button', { className: pillClass }, [
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

    // period chooser — only on views with a time-aggregated chart
    if (PERIOD_VIEWS.has(readHash().view)) {
      bar.append(periodChooser());
    }

    // right group, left to right: refresh · LIVE · status/MEM
    const right = el('div', { className: 'group', attrs: { style: 'margin-left:auto' } });
    // LIVE is a DERIVED status, not a manual toggle: it's on whenever the window
    // intersects the open _current interval (+ a fresh host). The only manual
    // lever is Pause/Resume, offered only when live is relevant — so the control
    // never fights its own auto on/off.
    const relevant = liveRelevant();
    const live = relevant && !state.paused;
    const liveChip = el('button', {
      className: live ? 'chip live on' : relevant ? 'chip live paused' : 'chip live',
      title: !relevant
        ? 'no live data in this range'
        : live
          ? 'live — click to pause'
          : 'paused — click to resume',
      on: {
        click: () => {
          if (!relevant) return; // display-only on a historical window
          state.paused = !state.paused;
          if (state.paused) {
            // HARD freeze: stop both auto-refresh timers entirely (not just guard
            // them) so nothing fires while paused
            stopRelativeRefresh();
            stopCurrentTracking();
          } else if (state.rangeSpec) {
            // resume: catch the frozen window up to now at once, then re-arm the
            // slide (the tracker re-arms via syncLiveWatch below)
            [state.startMs, state.endMs] = resolveRange(state.rangeSpec, Date.now(), isUtcMode());
            softRefreshView();
            startRelativeRefresh();
          }
          syncLiveWatch();
          render();
        },
      },
    });
    liveChip.disabled = !relevant; // a historical window's chip is just an indicator
    const paused = relevant && state.paused;
    const indicator = paused
      ? el('span', {
          className: 'live-pause',
          html:
            '<svg viewBox="0 0 10 10" width="8" height="9" fill="currentColor" aria-hidden="true">' +
            '<rect x="1.4" y="1" width="2.4" height="8" rx="0.6"></rect>' +
            '<rect x="6.2" y="1" width="2.4" height="8" rx="0.6"></rect></svg>',
        })
      : el('span', { className: 'dot' });
    liveChip.append(indicator, el('span', { text: paused ? 'PAUSED' : 'LIVE' }));

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
          liveStatusSig = null; // force a fresh liveStatus probe (manual recovery)
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
    disposed = true; // any in-flight async continuation must now bail
    storeClient.removeEventListener('progress', onProgress);
    storeClient.removeEventListener('data', updateLoadedText);
    stopCurrentTracking(); // drop the "all current" discovery timer
    stopRelativeRefresh(); // drop the relative-range auto-refresh timer
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

  if (state.rangeSpec) startRelativeRefresh(); // a relative range deep-link slides from load

  render();
}

/** Null-safe range token, for comparing the active spec across a URL sync. */
function tokenOf(spec: RangeSpec | null): string {
  return spec ? rangeToken(spec) : '';
}

/** Order-insensitive equality of two host lists (both are sorted in practice). */
function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
