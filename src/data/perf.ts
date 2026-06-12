/**
 * The viewer watching itself (SPEC §6, #/perf): a capped in-memory log of
 * internal timings — listings, fetches, parses, scans, view renders, live
 * cycles — plus main-thread stalls from the longtask observer. Entries are
 * plain monomorphic objects in a ring buffer; recording costs two
 * `performance.now()` calls and a push, so instrumentation stays cheap
 * enough to leave on always (memory thrift, SPEC §8: the log itself is
 * bounded). The #/perf page renders this; its copy-JSON export is how
 * stress-run numbers travel into LIMITS.md.
 */

export type PerfCategory =
  | 'list' // S3 listings / scan planning
  | 'fetch' // one object: network or IndexedDB cache
  | 'parse' // one file: NDJSON → records
  | 'scan' // a whole executeScan
  | 'render' // one view render
  | 'live' // one live-mode tick
  | 'stall'; // main-thread long task (≥50 ms)

export interface PerfEntry {
  /** epoch ms when the operation finished */
  ts: number;
  cat: PerfCategory;
  name: string;
  /** free-form context: key, view, counts */
  detail?: string;
  /** duration in ms */
  ms: number;
  bytes?: number;
  records?: number;
  /** fetch only: served from the IndexedDB cache */
  cached?: boolean;
  /** usedJSHeapSize stamped at completion (Chromium only) */
  heap?: number;
}

const MAX_ENTRIES = 2500; // a 448-file scan emits ~950 entries — leave room

function heapNow(): number | undefined {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem && typeof mem.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : undefined;
}

export class PerfLog extends EventTarget {
  /** newest last; render newest-first by walking backwards */
  entries: PerfEntry[] = [];
  /** monotonically increasing; views compare to know the log changed */
  generation = 0;

  /**
   * Start timing an operation. The returned function records the entry,
   * optionally patched with detail/bytes/records/cached.
   */
  begin(cat: PerfCategory, name: string): (patch?: Partial<PerfEntry>) => void {
    const t0 = performance.now();
    return (patch = {}) => {
      this.push({ ts: Date.now(), cat, name, ms: performance.now() - t0, ...patch });
    };
  }

  push(entry: PerfEntry): void {
    entry.heap ??= heapNow();
    // sub-0.1 ms precision is float noise; rounding keeps exports compact
    entry.ms = Math.round(entry.ms * 10) / 10;
    entry.ts = Math.round(entry.ts);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.generation++;
    this.dispatchEvent(new Event('entry'));
  }

  clear(): void {
    this.entries = [];
    this.generation++;
    this.dispatchEvent(new Event('entry'));
  }

  /**
   * The whole log as JSON — the export that travels into LIMITS.md. A
   * computed summary leads (the topline a human wants without crunching);
   * entries follow one compact line each (easy to eyeball, easy to jq).
   */
  exportJson(): string {
    const byCategory: Record<string, { count: number; totalMs: number }> = {};
    let worstStallMs = 0;
    let peakHeap = 0;
    for (const e of this.entries) {
      const c = (byCategory[e.cat] ??= { count: 0, totalMs: 0 });
      c.count++;
      c.totalMs += e.ms;
      if (e.cat === 'stall' && e.ms > worstStallMs) worstStallMs = e.ms;
      if (e.heap && e.heap > peakHeap) peakHeap = e.heap;
    }
    for (const c of Object.values(byCategory)) c.totalMs = Math.round(c.totalMs);
    const meta = {
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      heap: heapNow(),
      summary: {
        byCategory,
        scans: this.entries
          .filter((e) => e.cat === 'scan')
          .map((e) => ({ detail: e.detail, ms: Math.round(e.ms), records: e.records })),
        worstStallMs: Math.round(worstStallMs),
        peakHeap: peakHeap || undefined,
      },
    };
    const head = JSON.stringify(meta, null, 2);
    const lines = this.entries.map((e) => '    ' + JSON.stringify(e)).join(',\n');
    return `${head.slice(0, -2)},\n  "entries": [\n${lines}\n  ]\n}`;
  }
}

export const perf = new PerfLog();

// Main-thread stalls: anything that blocks ≥50 ms (renders, parses, GC).
// Unsupported environments (Safari, vitest) land in the catch and miss
// nothing else.
try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.push({
        ts: Date.now() - (performance.now() - entry.startTime),
        cat: 'stall',
        name: 'main thread blocked',
        ms: entry.duration,
      });
    }
  });
  observer.observe({ type: 'longtask', buffered: true });
} catch {
  /* longtask unsupported */
}
