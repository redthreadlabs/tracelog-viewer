/**
 * gzip codec over the platform's Compression Streams API (SPEC §3.3, §8).
 * Tracelog objects are served with `Content-Encoding: gzip`, so the fetch
 * layer hands us *decompressed* bytes; to cache them compactly in IndexedDB
 * we re-gzip here, and inflate again on the way back out. Both directions go
 * through a Blob → stream → Response round-trip, which is the most broadly
 * supported way to drive (De)CompressionStream to completion.
 */

/** Inflate gzipped bytes. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Deflate bytes to a single-member gzip blob. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Whether a buffer begins with the gzip magic bytes (1f 8b). */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate gzipped bytes and hand each newline-delimited line to `onLine`,
 * WITHOUT ever holding the whole decompressed body — the inflate is consumed a
 * chunk at a time and only a partial-line tail is buffered (SPEC §8). Returns
 * the total decompressed byte length (the figure the size ledger wants).
 *
 * This is the parse path: streaming means peak memory is one chunk, not the
 * file, and each `Rec`'s field slices pin only their own small line rather than
 * the entire decompressed string.
 */
export async function gunzipForEachLine(
  gz: Uint8Array,
  onLine: (line: string, lineNo: number) => void,
): Promise<number> {
  const reader = new Blob([gz as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lineNo = -1;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    buf += decoder.decode(value, { stream: true });
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      onLine(buf.slice(start, nl), ++lineNo);
      start = nl + 1;
    }
    if (start > 0) buf = buf.slice(start); // keep only the partial trailing line
  }
  buf += decoder.decode();
  if (buf.length > 0) onLine(buf, ++lineNo);
  return total;
}

/**
 * The nth (0-based) line of gzipped bytes, streamed with EARLY STOP — we cancel
 * the inflate the moment we reach line `n`, so a raw-line peek near the front of
 * a big file decompresses almost nothing. Null if the file has fewer lines.
 */
export async function gunzipLineN(gz: Uint8Array, n: number): Promise<string | null> {
  const reader = new Blob([gz as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lineNo = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf('\n', start)) !== -1) {
        if (++lineNo === n) return buf.slice(start, nl);
        start = nl + 1;
      }
      if (start > 0) buf = buf.slice(start);
    }
    buf += decoder.decode();
    return buf.length > 0 && ++lineNo === n ? buf : null;
  } finally {
    await reader.cancel().catch(() => {}); // stop inflating the rest
  }
}
