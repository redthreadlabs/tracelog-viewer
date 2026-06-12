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
  running: boolean;
  error?: string;
}

export class Store extends EventTarget {
  records: Rec[] = [];
  kindCounts = new Map<RecordKind, number>();
  channelCounts = new Map<string, number>();
  levelCounts = new Map<string, number>();
  hosts = new Set<string>();
  progress: ScanProgress = { filesTotal: 0, filesDone: 0, bytesDone: 0, running: false };

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
