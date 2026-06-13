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
