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
 * dropped. Records keep their original line as a sliced string and the
 * small normalized fields; parseRaw() re-parses on demand.
 */
import type { ParsedKey } from '../s3/keys';
import { RECORD_KINDS, type FileMeta, type Rec, type RecordKind } from './types';

export interface ParseResult {
  records: Rec[];
  metas: FileMeta[];
  skippedLines: number;
  unknownKinds: number;
}

let nextId = 1;

/**
 * Manual string intern pool. V8 internalizes JSON property *keys* but never
 * values, so a million events with level "info" would otherwise hold a
 * million separate heap strings. High-multiplicity fields (names, levels,
 * results, outcomes, user ids, device strings, paths, agents) pass through
 * here at normalize time; unique ids (trace_id etc.) deliberately do not —
 * interning them would grow the pool without creating sharing. Cleared at
 * the start of each scan.
 */
const internPool = new Map<string, string>();

export function clearInternPool(): void {
  internPool.clear();
}

function intern(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hit = internPool.get(value);
  if (hit !== undefined) return hit;
  internPool.set(value, value);
  return value;
}

/** intern(str(v)) — the canonical instance of a parsed string field */
function istr(value: unknown): string | undefined {
  return intern(str(value));
}

/** Re-parse a record's original line on demand; returns the record body. */
export function parseRaw(rec: Rec): Record<string, unknown> {
  try {
    const obj = JSON.parse(rec.rawLine) as Record<string, unknown>;
    const body = obj[rec.kind];
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseFile(bytes: Uint8Array, file: ParsedKey): ParseResult {
  const text = new TextDecoder().decode(bytes);
  const records: Rec[] = [];
  const metas: FileMeta[] = [];
  let meta: FileMeta = {};
  let skippedLines = 0;
  let unknownKinds = 0;

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.trim() === '') continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }

    const kind = Object.keys(obj)[0];
    const body = obj[kind] as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      skippedLines++;
      continue;
    }

    if (kind === 'metadata') {
      meta = extractMeta(body);
      metas.push(meta);
      continue;
    }

    if (!RECORD_KINDS.includes(kind as RecordKind)) {
      unknownKinds++;
      continue;
    }

    records.push(normalize(kind as RecordKind, body, line, file, meta));
  }

  return { records, metas, skippedLines, unknownKinds };
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
  file: ParsedKey,
  meta: FileMeta,
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
      name = istr(body.name) ?? '(unnamed)';
      outcome = istr(body.outcome);
      result = istr(body.result);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      selfId = str(body.id);
      userId = istr(ctxUser.id);
      const request = context.request as Record<string, unknown> | undefined;
      if (request) {
        const url = request.url as Record<string, unknown> | undefined;
        const headers = request.headers as Record<string, unknown> | undefined;
        path = istr(url?.pathname);
        agent = istr(headers?.['user-agent']);
        const fwd = headers?.['x-forwarded-for'];
        ip =
          typeof fwd === 'string'
            ? intern(fwd.split(',')[0].trim())
            : istr((request.socket as Record<string, unknown> | undefined)?.remote_address);
      }
      break;
    }
    case 'span': {
      name = istr(body.name) ?? '(unnamed)';
      const type = str(body.type);
      const subtype = str(body.subtype);
      result = intern(subtype ? `${type}/${subtype}` : type);
      outcome = istr(body.outcome);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      selfId = str(body.id);
      parentId = str(body.parent_id);
      userId = istr(ctxUser.id);
      break;
    }
    case 'event': {
      name = istr(body.type) ?? 'event';
      level = istr(body.level) ?? 'info';
      message = str(body.message);
      duration = num(body.duration);
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      const user = (body.user ?? {}) as Record<string, unknown>;
      userId = istr(user.id);
      const error = body.error as Record<string, unknown> | undefined;
      if (error && message === undefined) message = str(error.message);
      const client = body.client as Record<string, unknown> | undefined;
      if (client) {
        appVersion = istr(client.version);
        const dev = client.device as Record<string, unknown> | undefined;
        const osObj = client.os as Record<string, unknown> | undefined;
        device = istr(dev?.model);
        const osName = str(osObj?.name);
        const osVersion = str(osObj?.version);
        os = osName ? intern(osVersion ? `${osName} ${osVersion}` : osName) : undefined;
      }
      break;
    }
    case 'error': {
      const exception = (body.exception ?? {}) as Record<string, unknown>;
      const log = (body.log ?? {}) as Record<string, unknown>;
      name = istr(exception.type) ?? 'error';
      message = str(exception.message) ?? str(log.message);
      level = 'error';
      traceId = str(body.trace_id);
      transactionId = str(body.transaction_id);
      userId = istr(ctxUser.id);
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
        result = intern(subtype ? `${type}/${subtype}` : (type ?? 'app'));
      }
      name = txn
        ? intern(`breakdown · ${str(txn.name) ?? '?'}`)!
        : intern(`${Object.keys(samples).length} samples`)!;
      break;
    }
  }

  // One literal, every field assigned: all records share one hidden class
  // regardless of kind (see types.ts).
  return {
    id: nextId++,
    kind,
    ts: usToMs(body.timestamp),
    channel: file.channel,
    host: file.host,
    sourceKey: file.key,
    meta,
    rawLine: line,
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
