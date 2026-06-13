// Record kinds are part of the shared contract (tracelog-schema).
import type { RecordKind } from '@redthreadlabs/tracelog-schema';
export { RECORD_KINDS } from '@redthreadlabs/tracelog-schema';
export type { RecordKind };

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
 * Memory model: the parsed object tree is NOT retained, and for records
 * from finalized (cacheable) files neither is the raw line — `rawLine` is
 * null for spans/transactions/metricsets and the drawer re-reads the line
 * from the IndexedDB cache via `line` + `sourceKey` (data/rawsource.ts).
 * Events and errors keep a *flattened copy* of their line so free-text
 * search stays deep where it matters without pinning the file's decoded
 * text (a plain slice would — V8 SlicedStrings share the parent). Records
 * from `_current` snapshots (never cached) keep slices of the small live
 * tail, as before. Everything any view aggregates over is extracted
 * eagerly into the small fields below, with high-multiplicity strings
 * interned. Keep the construction in parse.ts monomorphic: every field is
 * always assigned, undefined/null when absent, so all records share one
 * hidden class.
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
  /** the original NDJSON line; null when shed (re-read on demand) */
  rawLine: string | null;
  /** 0-based line index in the source file (for on-demand raw re-reads) */
  line: number;
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
