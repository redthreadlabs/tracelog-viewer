/**
 * NDJSON parsing + kind dispatch + timestamp normalization (SPEC §3.3–3.5).
 *
 * - metadata is parsed positionally: a restart mid-day appends another
 *   metadata line, and every subsequent record belongs to that context.
 * - all serialized timestamps are epoch-µs (tracelog ≥1.7.0); they become
 *   epoch-ms here and nowhere else.
 * - unknown record kinds and extra fields are ignored, never fatal.
 * - lines are roughly but not strictly chronological — the caller sorts.
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

    records.push(normalize(kind as RecordKind, body, file, meta));
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
  file: ParsedKey,
  meta: FileMeta,
): Rec {
  const rec: Rec = {
    id: nextId++,
    kind,
    ts: usToMs(body.timestamp),
    channel: file.channel,
    host: file.host,
    sourceKey: file.key,
    meta,
    name: '',
    raw: body,
  };

  const context = (body.context ?? {}) as Record<string, unknown>;
  const ctxUser = (context.user ?? {}) as Record<string, unknown>;

  switch (kind) {
    case 'transaction': {
      rec.name = str(body.name) ?? '(unnamed)';
      rec.outcome = str(body.outcome);
      rec.result = str(body.result);
      rec.duration = num(body.duration);
      rec.traceId = str(body.trace_id);
      rec.userId = str(ctxUser.id);
      break;
    }
    case 'span': {
      rec.name = str(body.name) ?? '(unnamed)';
      const type = str(body.type);
      const subtype = str(body.subtype);
      rec.result = subtype ? `${type}/${subtype}` : type;
      rec.outcome = str(body.outcome);
      rec.duration = num(body.duration);
      rec.traceId = str(body.trace_id);
      rec.transactionId = str(body.transaction_id);
      rec.userId = str(ctxUser.id);
      break;
    }
    case 'event': {
      rec.name = str(body.type) ?? 'event';
      rec.level = str(body.level) ?? 'info';
      rec.message = str(body.message);
      rec.duration = num(body.duration);
      rec.traceId = str(body.trace_id);
      rec.transactionId = str(body.transaction_id);
      const user = (body.user ?? {}) as Record<string, unknown>;
      rec.userId = str(user.id);
      const error = body.error as Record<string, unknown> | undefined;
      if (error && !rec.message) rec.message = str(error.message);
      break;
    }
    case 'error': {
      const exception = (body.exception ?? {}) as Record<string, unknown>;
      const log = (body.log ?? {}) as Record<string, unknown>;
      rec.name = str(exception.type) ?? 'error';
      rec.message = str(exception.message) ?? str(log.message);
      rec.level = 'error';
      rec.traceId = str(body.trace_id);
      rec.transactionId = str(body.transaction_id);
      rec.userId = str(ctxUser.id);
      break;
    }
    case 'metricset': {
      const samples = (body.samples ?? {}) as Record<string, unknown>;
      const txn = body.transaction as Record<string, unknown> | undefined;
      rec.name = txn
        ? `breakdown · ${str(txn.name) ?? '?'}`
        : `${Object.keys(samples).length} samples`;
      break;
    }
  }

  return rec;
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
