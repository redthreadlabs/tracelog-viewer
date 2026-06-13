/**
 * The S3 key layout lives in @redthreadlabs/tracelog-schema now — the single
 * source of truth shared with the writer (the tracelog agent). This module
 * re-exports it so the viewer's existing `../s3/keys` import paths keep
 * working unchanged.
 */
export {
  buildKey,
  parseKey,
  intervalSpan,
  overlapsRange,
  dedupeCurrents,
  normalizeHost,
} from '@redthreadlabs/tracelog-schema';
export type { ParsedKey, KeyVars } from '@redthreadlabs/tracelog-schema';
