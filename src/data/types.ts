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
 * happens exactly once, at parse time (SPEC §3.4). `raw` keeps the original
 * record body for the detail panel.
 */
export interface Rec {
  id: number;
  kind: RecordKind;
  ts: number;
  channel: string;
  host: string;
  meta: FileMeta;
  /** primary display string: transaction/span name, event type, error message, … */
  name: string;
  level?: string;
  outcome?: string;
  result?: string;
  /** ms */
  duration?: number;
  traceId?: string;
  transactionId?: string;
  userId?: string;
  message?: string;
  raw: Record<string, unknown>;
}
