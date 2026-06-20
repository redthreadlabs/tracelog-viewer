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
// The schema renamed these to be object-store-neutral (0.4.0); the viewer keeps
// its local `ParsedKey` / `KeyVars` names via aliased re-export.
export type {
  ParsedObjectKey as ParsedKey,
  ObjectKeyVars as KeyVars,
} from '@redthreadlabs/tracelog-schema';
