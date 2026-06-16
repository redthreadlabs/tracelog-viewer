/**
 * NDJSON parsing + kind dispatch + timestamp normalization (SPEC §3.3–3.5).
 *
 * - metadata is parsed positionally: a restart mid-day appends another
 *   metadata line, and every subsequent record belongs to that context.
 * - all serialized timestamps are epoch-µs (tracelog ≥1.7.0); they become
 *   epoch-ms here and nowhere else.
 * - unknown record kinds and extra fields are ignored, never fatal.
 * - lines are roughly but not strictly chronological — the caller sorts.
 *
 * Memory model (SPEC §8): the parsed tree is used for extraction and then
 * dropped. With `shedRaw` (finalized files, which are in the IndexedDB
 * cache), spans/transactions/metricsets drop their raw line entirely —
 * rawsource.ts re-reads it on demand by line index — and events/errors
 * keep a flattened copy (deep free-text search); a plain slice would pin
 * the whole decoded file text via its SlicedString parent. Without
 * `shedRaw` (live `_current` tails, never cached), every record keeps a
 * slice as before; the shared parent is just the small tail.
 */
import type { ParsedKey } from '../s3/keys';
import { RECORD_KINDS, type FileMeta, type Rec, type RecordKind } from './types';
import { gunzipForEachLine } from './gzip';

export interface ParseResult {
  records: Rec[];
  metas: FileMeta[];
  /** the metadata context in effect at end-of-file (for incremental tails) */
  lastMeta: FileMeta;
  /** decompressed size of what was parsed */
  byteLength: number;
  skippedLines: number;
  unknownKinds: number;
}

let nextId = 1;

/**
 * String intern pools. V8 internalizes JSON property *keys* but never
 * values, so a million events with level "info" would otherwise hold a
 * million separate heap strings. High-multiplicity fields (names, levels,
 * results, outcomes, user ids, device strings, paths, agents) pass through
 * a pool at normalize time; unique ids (trace_id etc.) deliberately do not.
 *
 * One pool **per parseFile call**, retained nowhere afterwards: strings are
 * shared within a file (where the multiplicity lives), and evicting a
 * file's records from the store actually frees them — a global pool would
 * pin every interned string until the next scan.
 */
type InternPool = Map<string, string>;

function intern(pool: InternPool, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hit = pool.get(value);
  if (hit !== undefined) return hit;
  pool.set(value, value);
  return value;
}

/** intern(str(v)) — the canonical instance of a parsed string field */
function istr(pool: InternPool, value: unknown): string | undefined {
  return intern(pool, str(value));
}

/** kinds whose raw line is always retained (deep free-text search) */
const RAW_KINDS: ReadonlySet<string> = new Set(['event', 'error']);

/** Force a flat copy so a kept line doesn't pin the file's decoded text. */
function flatten(s: string): string {
  return (' ' + s).slice(1);
}

/** The 0-based `n`th line of decoded file text (on-demand raw re-reads). */
export function nthLine(text: string, n: number): string | null {
  let start = 0;
  for (let i = 0; i < n; i++) {
    const next = text.indexOf('\n', start);
    if (next === -1) return null;
    start = next + 1;
  }
  if (start >= text.length) return null;
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * Re-parse a record's retained line; returns the record body. Records that
 * shed their line return {} here — use rawsource.loadRawBody, which falls
 * back to the cache/bucket.
 */
export function parseRaw(rec: Rec): Record<string, unknown> {
  if (rec.rawLine === null) return {};
  try {
    const obj = JSON.parse(rec.rawLine) as Record<string, unknown>;
    const body = obj[rec.kind];
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A line-at-a-time NDJSON parser holding the per-file state (intern pool,
 * positional metadata context, counts). Feeding it line by line — whether from
 * a decoded buffer (`parseFile`) or a streamed inflate (`parseFileStreaming`) —
 * yields the identical result, so the two paths share this one source of truth.
 */
interface LineParser {
  push(line: string, lineNo: number): void;
  finish(byteLength: number): ParseResult;
}
function createLineParser(file: ParsedKey, initialMeta: FileMeta, shedRaw: boolean): LineParser {
  const pool: InternPool = new Map();
  const records: Rec[] = [];
  const metas: FileMeta[] = [];
  let meta: FileMeta = initialMeta;
  let skippedLines = 0;
  let unknownKinds = 0;
  return {
    push(line, lineNo) {
      if (line.trim() === '') return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        skippedLines++;
        return;
      }
      const kind = Object.keys(obj)[0];
      const body = obj[kind] as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        skippedLines++;
        return;
      }
      if (kind === 'metadata') {
        meta = extractMeta(body);
        metas.push(meta);
        return;
      }
      if (!RECORD_KINDS.includes(kind as RecordKind)) {
        unknownKinds++;
        return;
      }
      records.push(normalize(kind as RecordKind, body, line, lineNo, shedRaw, file, meta, pool));
    },
    finish(byteLength) {
      return { records, metas, lastMeta: meta, byteLength, skippedLines, unknownKinds };
    },
  };
}

export function parseFile(
  bytes: Uint8Array,
  file: ParsedKey,
  initialMeta: FileMeta = {},
  shedRaw = false,
): ParseResult {
  const text = new TextDecoder().decode(bytes);
  const p = createLineParser(file, initialMeta, shedRaw);
  let start = 0;
  let lineNo = -1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    p.push(text.slice(start, end), ++lineNo);
    start = end + 1;
  }
  return p.finish(bytes.length);
}

/**
 * Parse a finalized file straight from its gzip bytes by STREAMING the inflate —
 * the decompressed body is never fully materialized (SPEC §8). Same result as
 * `parseFile`, used for cached (immutable) files; the volatile `_current` path
 * stays on `parseFile` since its bytes arrive already inflated.
 */
export async function parseFileStreaming(
  gz: Uint8Array,
  file: ParsedKey,
  initialMeta: FileMeta = {},
  shedRaw = false,
): Promise<ParseResult> {
  const p = createLineParser(file, initialMeta, shedRaw);
  const byteLength = await gunzipForEachLine(gz, (line, lineNo) => p.push(line, lineNo));
  return p.finish(byteLength);
}

function extractMeta(body: Record<string, unknown>): FileMeta {
  const service = (body.service ?? {}) as Record<string, unknown>;
  const agent = (service.agent ?? {}) as Record<string, unknown>;
  const node = (service.node ?? {}) as Record<string, unknown>;
  const process = (body.process ?? {}) as Record<string, unknown>;
  return {
    serviceName: str(service.name),
    serviceVersion: str(service.version),
    environment: str(service.environment),
    agentVersion: str(agent.version),
    nodeName: str(node.configured_name),
    channel: str(body.channel),
    pid: typeof process.pid === 'number' ? process.pid : undefined,
  };
}

function normalize(
  kind: RecordKind,
  body: Record<string, unknown>,
  line: string,
  lineNo: number,
  shedRaw: boolean,
  file: ParsedKey,
  meta: FileMeta,
  pool: InternPool,
): Rec {
  let name = '';
  let level: string | undefined;
  let outcome: string | undefined;
  let result: string | undefined;
  let duration: number | undefined;
  let traceId: string | undefined;
  let transactionId: string | undefined;
  let selfId: string | undefined;
  let parentId: string | undefined;
  let userId: string | undefined;
  let message: string | undefined;
  let samples: Record<string, number> | undefined;
  let appVersion: string | undefined;
  let device: string | undefined;
  let os: string | undefined;
  let path: string | undefined;
  let agent: string | undefined;
  let ip: string | undefined;

  const context = (body.context ?? {}) as Record<string, unknown>;
  const ctxUser = (context.user ?? {}) as Record<string, unknown>;

  switch (kind) {
    case 'transaction': {
      name = istr(pool, body.name) ?? '(unnamed)';
      outcome = istr(pool, body.outcome);
      result = istr(pool, body.result);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      selfId = str(body.id);
      userId = istr(pool, ctxUser.id);
      const request = context.request as Record<string, unknown> | undefined;
      if (request) {
        const url = request.url as Record<string, unknown> | undefined;
        const headers = request.headers as Record<string, unknown> | undefined;
        path = istr(pool, url?.pathname);
        agent = istr(pool, headers?.['user-agent']);
        const fwd = headers?.['x-forwarded-for'];
        ip =
          typeof fwd === 'string'
            ? intern(pool, fwd.split(',')[0].trim())
            : istr(pool, (request.socket as Record<string, unknown> | undefined)?.remote_address);
      }
      break;
    }
    case 'span': {
      name = istr(pool, body.name) ?? '(unnamed)';
      const type = str(body.type);
      const subtype = str(body.subtype);
      result = intern(pool, subtype ? `${type}/${subtype}` : type);
      outcome = istr(pool, body.outcome);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      selfId = str(body.id);
      parentId = str(body.parent_id);
      userId = istr(pool, ctxUser.id);
      break;
    }
    case 'event': {
      name = istr(pool, body.type) ?? 'event';
      level = istr(pool, body.level) ?? 'info';
      message = str(body.message);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      const user = (body.user ?? {}) as Record<string, unknown>;
      userId = istr(pool, user.id);
      const error = body.error as Record<string, unknown> | undefined;
      if (error && message === undefined) message = str(error.message);
      const client = body.client as Record<string, unknown> | undefined;
      if (client) {
        appVersion = istr(pool, client.version);
        const dev = client.device as Record<string, unknown> | undefined;
        const osObj = client.os as Record<string, unknown> | undefined;
        device = istr(pool, dev?.model);
        const osName = str(osObj?.name);
        const osVersion = str(osObj?.version);
        os = osName ? intern(pool, osVersion ? `${osName} ${osVersion}` : osName) : undefined;
      }
      break;
    }
    case 'error': {
      const exception = (body.exception ?? {}) as Record<string, unknown>;
      const log = (body.log ?? {}) as Record<string, unknown>;
      name = istr(pool, exception.type) ?? 'error';
      message = str(exception.message) ?? str(log.message);
      level = 'error';
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      userId = istr(pool, ctxUser.id);
      break;
    }
    case 'metricset': {
      const rawSamples = (body.samples ?? {}) as Record<string, unknown>;
      samples = {};
      for (const key of Object.keys(rawSamples)) {
        const sample = rawSamples[key] as Record<string, unknown> | undefined;
        const value = sample?.value;
        if (typeof value === 'number' && isFinite(value)) samples[key] = value;
      }
      const span = body.span as Record<string, unknown> | undefined;
      const txn = body.transaction as Record<string, unknown> | undefined;
      if (span) {
        const type = str(span.type);
        const subtype = str(span.subtype);
        result = intern(pool, subtype ? `${type}/${subtype}` : (type ?? 'app'));
      }
      name = txn
        ? intern(pool, `breakdown · ${str(txn.name) ?? '?'}`)!
        : intern(pool, `${Object.keys(samples).length} samples`)!;
      break;
    }
  }

  // One literal, every field assigned: all records share one hidden class
  // regardless of kind (see types.ts).
  const rawLine = !shedRaw ? line : RAW_KINDS.has(kind) ? flatten(line) : null;
  return {
    id: nextId++,
    kind,
    ts: usToMs(body.timestamp),
    tzOffset: typeof body.tz_offset === 'number' && isFinite(body.tz_offset) ? body.tz_offset : undefined,
    channel: file.channel,
    host: file.host,
    sourceKey: file.key,
    meta,
    rawLine,
    line: lineNo,
    name,
    level,
    outcome,
    result,
    duration,
    traceId,
    transactionId,
    selfId,
    parentId,
    userId,
    message,
    samples,
    appVersion,
    device,
    os,
    path,
    agent,
    ip,
  };
}

/** epoch-µs → epoch-ms; tolerate missing/garbage timestamps. */
function usToMs(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  return value / 1000;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && isFinite(value) ? value : undefined;
}
