/**
 * On-demand raw record bodies (SPEC §8): records from finalized files shed
 * their rawLine at parse time, because the bytes already sit in the
 * IndexedDB cache. When a drawer wants the raw JSON, this re-reads the
 * file (cache first, bucket as fallback), decodes it, and takes the
 * record's line — ~30 ms for a large file, imperceptible behind a click,
 * versus hundreds of MB of heap if every record kept its line.
 */
import { cacheGetAny } from './cache';
import { parseRaw, nthLine } from './parse';
import { perf } from './perf';
import type { Rec } from './types';

export interface RawSource {
  bucket: string;
  fetch: (key: string) => Promise<Uint8Array>;
}

let source: RawSource | null = null;

/** app.ts registers the active bucket here on connect (null disconnects). */
export function registerRawSource(s: RawSource | null): void {
  source = s;
}

/** The record body, whether the line was retained or must be re-read. */
export async function loadRawBody(rec: Rec): Promise<Record<string, unknown>> {
  if (rec.rawLine !== null) return parseRaw(rec);
  if (!source) return {};
  try {
    const done = perf.begin('fetch', rec.sourceKey);
    let bytes = await cacheGetAny(source.bucket, rec.sourceKey);
    const fromCache = bytes !== null;
    if (!bytes) bytes = await source.fetch(rec.sourceKey);
    done({ detail: `raw line ${rec.line}`, bytes: bytes.length, cached: fromCache });
    const line = nthLine(new TextDecoder().decode(bytes), rec.line);
    if (line === null) return {};
    const obj = JSON.parse(line) as Record<string, unknown>;
    const body = obj[rec.kind];
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
