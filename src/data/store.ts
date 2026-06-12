/**
 * In-memory record store (SPEC §5). Views render from here and subscribe to
 * updates; the scan layer appends batches as files land so views populate
 * incrementally (stream-render, SPEC §7).
 */
import type { Rec, RecordKind } from './types';

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
  progress: ScanProgress = {
    filesTotal: 0,
    filesDone: 0,
    bytesDone: 0,
    filesFromCache: 0,
    running: false,
  };

  /** monotonically increasing; views compare to know the data changed */
  generation = 0;

  addBatch(batch: Rec[]): void {
    for (const rec of batch) {
      this.records.push(rec);
      bump(this.kindCounts, rec.kind);
      bump(this.channelCounts, rec.channel);
      if (rec.level) bump(this.levelCounts, rec.level);
      this.hosts.add(rec.host);
    }
    this.generation++;
    this.dispatchEvent(new Event('data'));
  }

  /** Sort once after a scan completes — lines arrive roughly ordered (§3.5). */
  sortByTime(): void {
    this.records.sort((a, b) => a.ts - b.ts);
    this.generation++;
    this.dispatchEvent(new Event('data'));
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
    this.dispatchEvent(new Event('data'));
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
    this.dispatchEvent(new Event('data'));
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
    this.generation++;
    this.dispatchEvent(new Event('data'));
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
