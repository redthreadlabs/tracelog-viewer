/**
 * Duration histogram (SPEC §11.6 mergeable sketch): the holistic companion to
 * the transaction cube, for estimating P95 without reading records. Per file it
 * stores, per (UTC hour, transaction), a log-spaced histogram of durations on
 * FIXED bins (10 µs → 1 h, 5 per decade). Fixed edges are the whole point —
 * every file's histogram aligns, so they merge by summing bin counts, and a
 * quantile is a cumulative-then-interpolate over the merged bins.
 *
 * (The display histogram in `aggregate.ts` uses DATA-DEPENDENT edges to fit one
 * dataset; those don't align across files, so they can't be merged — hence this
 * separate fixed-edge scheme.)
 */
import type { Rec } from './types';
import { hourInterval } from '@redthreadlabs/tracelog-schema';
import { openDb, DURHIST_STORE, SEP, bucketRange } from './cache';

const MIN_MS = 0.01; // 10 µs floor; anything smaller lands in bin 0
const PER_DECADE = 5;
const STEP = 1 / PER_DECADE; // log10 decades per bin (0.2)
const LO = Math.log10(MIN_MS); // -2
const HI = Math.log10(3_600_000); // 1 h ≈ 6.556
export const DURHIST_BINS = Math.ceil((HI - LO) / STEP); // 43; top bin is the overflow

/** The fixed bin a duration (ms) falls in. Clamped to [0, DURHIST_BINS-1]. */
export function durationBin(ms: number): number {
  const i = Math.floor((Math.log10(Math.max(ms, MIN_MS)) - LO) / STEP);
  return i < 0 ? 0 : i >= DURHIST_BINS ? DURHIST_BINS - 1 : i;
}

/** The ms value at bin index `i` (its lower edge); fractional `i` interpolates. */
export function binValue(i: number): number {
  return Math.pow(10, LO + i * STEP);
}

/** sparse bin counts: bin index (as a string key) → count */
export type Bins = Record<string, number>;
/** UTC hour label → transaction name → its duration histogram */
export type DurHistFileIndex = Record<string, Record<string, Bins>>;

/** Build a file's duration histograms (transactions with a duration). Pure. */
export function buildDurHist(records: Rec[]): DurHistFileIndex {
  const index: DurHistFileIndex = {};
  for (const r of records) {
    if (r.kind !== 'transaction' || r.ts <= 0 || r.duration === undefined) continue;
    const byName = (index[hourInterval(r.ts)] ??= {});
    const bins = (byName[r.name] ??= {});
    const b = durationBin(r.duration);
    bins[b] = (bins[b] ?? 0) + 1;
  }
  return index;
}

/** Add `from`'s counts into `into` (mergeable because the bins are fixed). */
export function mergeBins(into: Bins, from: Bins): void {
  for (const k in from) into[k] = (into[k] ?? 0) + from[k];
}

const HOUR_MS = 3_600_000;

/** Parse a UTC hour label 'YYYY-MM-DDTHH' back to epoch-ms, or null. */
function hourLabelToMs(label: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(label);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

/**
 * Merge one file's histograms — for hours fully inside [from, to) — into a
 * per-transaction accumulator. The holistic counterpart of `txnIndexPoints`:
 * summed bins across files give a range-wide distribution to read a quantile
 * from. (Only whole-in-range hours, so a bin is never split at a range edge.)
 */
export function mergeRangeBins(
  index: DurHistFileIndex,
  from: number,
  to: number,
  into: Map<string, Bins>,
): void {
  for (const label in index) {
    const t = hourLabelToMs(label);
    if (t === null || t < from || t + HOUR_MS > to) continue;
    const byName = index[label];
    for (const name in byName) {
      let bins = into.get(name);
      if (!bins) into.set(name, (bins = {}));
      mergeBins(bins, byName[name]);
    }
  }
}

/**
 * Estimate the `p` (0..1) quantile from merged bins: walk bins in ascending
 * order to the one where the cumulative count crosses `p·total`, then
 * log-interpolate within it. Error is bounded by the bin width (~×10^STEP).
 * Undefined when empty.
 */
export function quantileFromBins(bins: Bins, p: number): number | undefined {
  const idxs = Object.keys(bins)
    .map(Number)
    .sort((a, b) => a - b);
  let total = 0;
  for (const i of idxs) total += bins[i];
  if (total === 0) return undefined;
  const target = p * total;
  let cum = 0;
  for (const i of idxs) {
    const c = bins[i];
    if (cum + c >= target) {
      const frac = c > 0 ? (target - cum) / c : 0; // position within the bin
      return binValue(i + frac);
    }
    cum += c;
  }
  return binValue(idxs[idxs.length - 1] + 1); // unreachable in practice
}

// --------------------------------------------------------------- IndexedDB I/O

export interface DurHistRecord {
  id: string; // `${bucket}\0${key}`
  etag?: string;
  index: DurHistFileIndex;
}

export async function putDurHist(
  bucket: string,
  key: string,
  etag: string | undefined,
  index: DurHistFileIndex,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DURHIST_STORE, 'readwrite');
      tx.objectStore(DURHIST_STORE).put({ id: bucket + SEP + key, etag, index } satisfies DurHistRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function durHistRecords(bucket: string): Promise<DurHistRecord[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db
        .transaction(DURHIST_STORE, 'readonly')
        .objectStore(DURHIST_STORE)
        .getAll(bucketRange(bucket));
      req.onsuccess = () => resolve((req.result as DurHistRecord[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
