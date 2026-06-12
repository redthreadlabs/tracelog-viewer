/**
 * In-memory record store (SPEC §5). Views render from here and subscribe to
 * updates; the scan layer appends batches as files land so views populate
 * incrementally (stream-render, SPEC §7).
 */
import type { Rec, RecordKind } from './types';
import type { ParsedKey } from '../s3/keys';
import { perf } from './perf';

/** What the store knows about one loaded source file (for the inspector). */
export interface FileInfo {
  key: string;
  channel: string;
  interval: string;
  host: string;
  current: boolean;
  /** compressed object size from the listing */
  sizeCompressed: number;
  /** decompressed bytes parsed (grows for live-appended snapshots) */
  sizeUncompressed: number;
  /** S3 Last-Modified from the listing, epoch-ms */
  lastModified?: number;
}

export interface ScanProgress {
  filesTotal: number;
  filesDone: number;
  bytesDone: number;
  filesFromCache: number;
  running: boolean;
  error?: string;
}

export class Store extends EventTarget {
  records: Rec[] = [];
  kindCounts = new Map<RecordKind, number>();
  channelCounts = new Map<string, number>();
  levelCounts = new Map<string, number>();
  hosts = new Set<string>();
  files = new Map<string, FileInfo>();
  progress: ScanProgress = {
    filesTotal: 0,
    filesDone: 0,
    bytesDone: 0,
    filesFromCache: 0,
    running: false,
  };

  /** monotonically increasing; views compare to know the data changed */
  generation = 0;

  /** Record (or update) what we know about a loaded source file. */
  registerFile(file: ParsedKey, uncompressedBytes: number, append = false): void {
    const existing = this.files.get(file.key);
    this.files.set(file.key, {
      key: file.key,
      channel: file.channel,
      interval: file.interval,
      host: file.host,
      current: file.current,
      sizeCompressed: file.size || (existing?.sizeCompressed ?? 0),
      sizeUncompressed: append
        ? (existing?.sizeUncompressed ?? 0) + uncompressedBytes
        : uncompressedBytes,
      lastModified: file.lastModified?.getTime() ?? existing?.lastModified,
    });
  }

  /** Remove a file from memory entirely (evict, or a _current finalized away). */
  dropFile(sourceKey: string): void {
    this.files.delete(sourceKey);
    this.replaceFile(sourceKey, []);
  }

  addBatch(batch: Rec[]): void {
    for (const rec of batch) {
      this.records.push(rec);
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
    this.generation++;
    this.emitData();
  }

  /** Sort once after a scan completes — lines arrive roughly ordered (§3.5). */
  sortByTime(): void {
    this.records.sort((a, b) => a.ts - b.ts);
    this.generation++;
    this.emitData();
  }

  /** Append a batch keeping time order (live mode: an append-only tail). */
  appendSorted(batch: Rec[]): void {
    if (batch.length === 0) return;
    for (const rec of batch) {
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
    this.records.push(...batch);
    this.records.sort((a, b) => a.ts - b.ts);
    this.generation++;
    this.emitData();
  }

  /**
   * Replace every record from one source file (live mode: a re-fetched
   * `_current` snapshot supersedes its previous contents; an empty batch
   * purges a `_current` that was finalized away).
   */
  replaceFile(sourceKey: string, batch: Rec[]): void {
    this.records = this.records.filter((r) => r.sourceKey !== sourceKey);
    this.records.push(...batch);
    this.records.sort((a, b) => a.ts - b.ts);
    this.rebuildIndexes();
    this.generation++;
    this.emitData();
  }

  private rebuildIndexes(): void {
    this.kindCounts.clear();
    this.channelCounts.clear();
    this.levelCounts.clear();
    this.hosts.clear();
    for (const rec of this.records) {
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
  }

  clear(): void {
    this.records = [];
    this.kindCounts.clear();
    this.channelCounts.clear();
    this.levelCounts.clear();
    this.hosts.clear();
    this.files.clear();
    this.progress = { filesTotal: 0, filesDone: 0, bytesDone: 0, filesFromCache: 0, running: false };
    this.generation++;
    this.emitData();
    this.dispatchEvent(new Event('progress'));
  }

  /**
   * Every store subscriber (the active view, the MEM pill) re-renders
   * synchronously inside this dispatch — timing it measures the incremental
   * UI cost of data landing, the number that degrades as the store grows
   * (#/internals/perf). Sub-millisecond updates aren't worth a log line.
   */
  private emitData(): void {
    const t0 = performance.now();
    this.dispatchEvent(new Event('data'));
    const ms = performance.now() - t0;
    if (ms >= 1) {
      perf.push({ ts: Date.now(), cat: 'render', name: 'view update', ms, records: this.records.length });
    }
  }

  setProgress(progress: Partial<ScanProgress>): void {
    this.progress = { ...this.progress, ...progress };
    this.dispatchEvent(new Event('progress'));
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export const store = new Store();
