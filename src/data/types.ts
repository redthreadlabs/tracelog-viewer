export type RecordKind = 'transaction' | 'span' | 'error' | 'event' | 'metricset';

export const RECORD_KINDS: RecordKind[] = [
  'transaction',
  'span',
  'error',
  'event',
  'metricset',
];

/** The per-file context established by metadata lines (SPEC §3.3). */
export interface FileMeta {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  agentVersion?: string;
  nodeName?: string;
  channel?: string;
  pid?: number;
}

/**
 * Normalized record envelope. `ts` is epoch-ms — the µs→ms conversion
 * happens exactly once, at parse time (SPEC §3.4).
 *
 * Memory model: the parsed object tree is NOT retained. `rawLine` keeps the
 * record's original NDJSON line as a sliced string (a ~16-byte view sharing
 * the decoded file text) and parseRaw() re-parses on demand (drawer, trace
 * detail). Everything any view aggregates over is extracted eagerly into
 * the small fields below, with high-multiplicity strings interned. Keep
 * the construction in parse.ts monomorphic: every field is always assigned,
 * undefined when absent, so all records share one hidden class.
 */
export interface Rec {
  id: number;
  kind: RecordKind;
  ts: number;
  channel: string;
  host: string;
  /** S3 key of the file this record came from — live mode replaces by key */
  sourceKey: string;
  meta: FileMeta;
  /** the record's original NDJSON line (sliced from the file text) */
  rawLine: string;
  /** primary display string: transaction/span name, event type, error type, … */
  name: string;
  level?: string;
  outcome?: string;
  /** result string; for spans and breakdown metricsets: `type/subtype` */
  result?: string;
  /** ms */
  duration?: number;
  traceId?: string;
  transactionId?: string;
  /** the record's own id (transactions and spans) */
  selfId?: string;
  /** a span's immediate parent (span or transaction id) */
  parentId?: string;
  userId?: string;
  message?: string;
  /** metricsets: numeric samples (name → value) */
  samples?: Record<string, number>;
  /** client events: app version / device model / "OS version" */
  appVersion?: string;
  device?: string;
  os?: string;
  /** transactions with HTTP request context: path, user agent, client IP */
  path?: string;
  agent?: string;
  ip?: string;
}
