/**
 * Update-cadence tracking for live `_current` files (SPEC §6.0). Every poll we
 * observe a file's S3 `LastModified` — the agent's ACTUAL flush time, not our
 * poll time — and keep a small rolling window of distinct values. From that we
 * estimate the typical update interval and decide whether a host is still
 * "current" (its heartbeat is alive) or has fallen too far behind and should be
 * dropped from the live set.
 *
 * Pure + unit-tested; the live poller (in memory) and the ledger (durable, for
 * cold-start) own the windows and feed them here.
 *
 * On polling resolution: sampling only blinds us to cadences FASTER than the
 * poll interval — and those hosts always look fresh, so they need no protection.
 * Cadences SLOWER than the poll are observed exactly (the deltas are real), and
 * those are precisely the ones that need a lenient staleness threshold so a host
 * isn't falsely dropped between two genuine updates.
 */

/** How many distinct LastModified values we retain per file. */
export const CADENCE_WINDOW = 8;

/**
 * Staleness tolerance: a host is current if its newest update is within
 * max(STALE_FLOOR_MS, STALE_K × observed cadence) of now. The observable
 * heartbeat is the agent's S3 UPLOAD (default `s3UploadIntervalMs` = 5 min),
 * NOT the 60 s metricset generation — metricsets batch into a 5-min upload, so
 * `LastModified` advances every ~5 min. STALE_K gives that proportional headroom
 * (~15 min); the floor only matters for hosts that upload faster than the floor.
 */
export const STALE_FLOOR_MS = 180_000; // 3 min — anti-flap floor for fast uploaders
export const STALE_K = 3;

/**
 * Staleness allowed before we've observed a cadence (a single LastModified). It
 * must comfortably exceed the agent's upload cadence so a live host isn't marked
 * dead between flushes — 12 min ≈ 2.4× the 5-min default, covering one missed
 * upload. Once two observations give a cadence, STALE_K × cadence takes over.
 * (False death is the costly failure — it strands the whole live UI — so this
 * leans generous; a genuinely dead host just lingers a few extra minutes.)
 */
export const BOOTSTRAP_STALE_MS = 720_000; // 12 min

/**
 * Append a freshly observed LastModified, keeping the window ascending,
 * distinct, and capped. A value not strictly newer than the last is ignored
 * (a sub-second re-flush, or a clock that stepped backwards) — it carries no new
 * timing. Pure: returns the same array when nothing changes, else a new one.
 */
export function pushMtime(mtimes: number[], t: number, max = CADENCE_WINDOW): number[] {
  if (mtimes.length && t <= mtimes[mtimes.length - 1]) return mtimes;
  const next = mtimes.length >= max ? [...mtimes.slice(mtimes.length - max + 1), t] : [...mtimes, t];
  return next;
}

/**
 * The typical update interval (ms): the MEDIAN of consecutive deltas, robust to
 * a single missed poll inflating one gap. Null with fewer than two observations.
 */
export function cadence(mtimes: number[]): number | null {
  if (mtimes.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < mtimes.length; i++) deltas.push(mtimes[i] - mtimes[i - 1]);
  deltas.sort((a, b) => a - b);
  const mid = deltas.length >> 1;
  return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
}

export interface CurrencyOpts {
  /** absolute staleness floor (ms); default STALE_FLOOR_MS */
  floorMs?: number;
  /** multiplier on observed cadence; default STALE_K */
  k?: number;
  /** staleness allowed before a cadence is known; default BOOTSTRAP_STALE_MS */
  bootstrapMs?: number;
}

/**
 * Whether a file's host is still current at `now` (skew-corrected client time):
 * its newest update is within max(floor, k × cadence) once a cadence is known,
 * else within the generous bootstrap window (a single observation can't reveal
 * cadence, and the agent may upload only every few minutes). An empty window →
 * never seen updating → not current.
 */
export function isCurrent(now: number, mtimes: number[], opts: CurrencyOpts = {}): boolean {
  if (mtimes.length === 0) return false;
  const floor = opts.floorMs ?? STALE_FLOOR_MS;
  const k = opts.k ?? STALE_K;
  const c = cadence(mtimes);
  const threshold = c != null ? Math.max(floor, k * c) : (opts.bootstrapMs ?? BOOTSTRAP_STALE_MS);
  return now - mtimes[mtimes.length - 1] <= threshold;
}

/**
 * When this file is next expected to update (ms): newest observation + cadence.
 * Null when there's no cadence yet — the caller falls back to a fixed poll.
 * Drives adaptive / per-host scheduling (a later phase); scheduling off the
 * observed LastModified, not our fire time, avoids accumulating drift.
 */
export function nextExpected(mtimes: number[]): number | null {
  const c = cadence(mtimes);
  return c != null ? mtimes[mtimes.length - 1] + c : null;
}
