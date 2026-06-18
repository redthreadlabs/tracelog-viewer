/**
 * Thin typed wrapper over @aws-sdk/client-s3 (SPEC §4: SDK only, no
 * hand-rolled signing; the viewer issues only ListObjectsV2 and GetObject).
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import type { Profile } from '../ui/profiles';
import { gunzip, isGzip } from '../data/gzip';
import { sidecarKey, type SidecarMeta } from '@redthreadlabs/tracelog-schema';

export interface ListedObject {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

/**
 * Normalize whatever the user typed into '' or a canonical `a/b/` form:
 * collapse any run of slashes, drop leading/trailing ones, append exactly
 * one. So `logs`, `/logs`, `logs/`, `//logs//`, ` logs ` → `logs/`, and
 * `logs/prod`, `/logs//prod/` → `logs/prod/`. Empty/blank → '' (bucket root).
 */
export function normalizePrefix(p?: string): string {
  const t = (p ?? '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return t ? `${t}/` : '';
}

export class LogBucket {
  private s3: S3Client;
  readonly bucket: string;
  /** S3 key prefix the channels live under ('' = bucket root); fully internal */
  private readonly prefix: string;
  /** whether `Range`-based raw-gzip fetches work here (cleared on first reject) */
  private rangeOk = true;

  constructor(profile: Profile) {
    this.bucket = profile.bucket;
    this.prefix = normalizePrefix(profile.prefix);
    this.s3 = new S3Client(
      profile.public
        ? {
            // public bucket: issue unsigned requests. The no-op signer
            // bypasses SigV4; the placeholder credentials just short-circuit
            // the credential provider chain (which would hang in a browser).
            region: profile.region,
            credentials: { accessKeyId: 'anonymous', secretAccessKey: 'anonymous' },
            signer: { sign: async (request) => request },
          }
        : {
            region: profile.region,
            credentials: {
              accessKeyId: profile.accessKeyId,
              secretAccessKey: profile.secretAccessKey,
              ...(profile.sessionToken ? { sessionToken: profile.sessionToken } : {}),
            },
          },
    );
  }

  /**
   * Top-level prefixes == channels (SPEC §3.2 recipe 1). With a bucket
   * prefix, channels live one level below it; we strip the prefix so callers
   * always see logical keys (`channel/interval/host…`).
   */
  async listChannels(): Promise<string[]> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, Delimiter: '/' }),
    );
    return (res.CommonPrefixes ?? [])
      .map((p) => (p.Prefix ?? '').slice(this.prefix.length).replace(/\/$/, ''))
      .filter(Boolean);
  }

  /**
   * The most recent interval present across the given channels, e.g.
   * `2026-06-11` (daily) or `2026-06-11T14` (hourly). Cheap: it lists the
   * interval *prefixes* via the delimiter, not the files inside them, and
   * intervals sort chronologically, so the max is the latest. Returns null
   * when none of the channels hold any data.
   */
  async latestInterval(channels: string[]): Promise<string | null> {
    let latest: string | null = null;
    for (const channel of channels) {
      const base = `${this.prefix}${channel}/`;
      let token: string | undefined;
      do {
        const res = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: base,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        );
        for (const cp of res.CommonPrefixes ?? []) {
          const interval = (cp.Prefix ?? '').slice(base.length).replace(/\/$/, '');
          if (interval && (latest === null || interval > latest)) latest = interval;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    }
    return latest;
  }

  /**
   * One paginated listing per channel for a date range (SPEC §3.2 recipe 2):
   * StartAfter positions before the first day; reading stops as soon as keys
   * sort past `{endDate}~` (`~` sorts after every interval char). The bucket
   * prefix is applied to the S3 request and stripped from returned keys.
   */
  async listChannelRange(
    channel: string,
    startDate: string,
    endDate: string,
  ): Promise<ListedObject[]> {
    const prefix = `${this.prefix}${channel}/`;
    const stopAt = `${this.prefix}${channel}/${endDate}~`;
    const out: ListedObject[] = [];
    let token: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          StartAfter: token ? undefined : `${this.prefix}${channel}/${startDate}`,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        if (obj.Key > stopAt) return out;
        out.push(toListed(obj, this.prefix));
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return out;
  }

  /**
   * Fetch one log file, returning decompressed bytes. Objects carry
   * `Content-Encoding: gzip`, so the browser's fetch layer usually inflates
   * transparently; when the body still starts with the gzip magic bytes
   * (e.g. a proxy stripped the header), inflate via DecompressionStream
   * (SPEC §3.3 — must not double-gunzip).
   */
  async getObjectBytes(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}` }),
    );
    if (!res.Body) return new Uint8Array(0);
    let bytes = await res.Body.transformToByteArray();
    if (isGzip(bytes)) bytes = await gunzip(bytes);
    return bytes;
  }

  /**
   * Conditional GET for live per-host polling (SPEC §6.0): one request that
   * returns the (decompressed) bytes + new ETag/LastModified when the object
   * changed, or 'unchanged' on a 304 (no body — tiny). `If-None-Match` against
   * the last ETag means no LIST and no separate HEAD; the LastModified is the
   * agent's real flush time, feeding the cadence estimate.
   */
  async getObjectIfChanged(
    key: string,
    etag: string | undefined,
  ): Promise<{ bytes: Uint8Array; etag?: string; lastModified?: Date } | 'unchanged'> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}${key}`,
          ...(etag ? { IfNoneMatch: etag } : {}),
        }),
      );
      let bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array(0);
      if (isGzip(bytes)) bytes = await gunzip(bytes);
      return { bytes, etag: res.ETag, lastModified: res.LastModified };
    } catch (err) {
      if (isNotModified(err)) return 'unchanged';
      throw err;
    }
  }

  /**
   * Fetch one file as STORED, without the fetch layer auto-inflating it
   * (SPEC §8). Tracelog objects carry `Content-Encoding: gzip`, so a plain
   * GET comes back already decompressed — wasteful when we want to *cache*
   * the small compressed form. A `Range: bytes=0-` request returns the whole
   * object as `206 Partial Content`, and browsers never decompress a partial
   * response, so we receive the raw gzip bytes verbatim. The caller checks
   * the gzip magic (a proxy, or a UA that ignores the Range, can still hand
   * back inflated bytes); if Range is rejected outright (e.g. CORS), we note
   * it and fall back to the normal decompressed GET for the rest of the run.
   */
  async getObjectCompressed(key: string): Promise<Uint8Array> {
    if (this.rangeOk) {
      try {
        const res = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}`, Range: 'bytes=0-' }),
        );
        if (res.Body) return res.Body.transformToByteArray();
      } catch {
        this.rangeOk = false; // Range unsupported here — stop probing
      }
    }
    return this.getObjectBytes(key);
  }

  /**
   * Fetch a finalized file's metadata sidecar (`<key>.meta.json`) — the
   * factual size/record/histogram facts the agent wrote alongside it. Plain
   * JSON (no Content-Encoding). Returns null on a miss (404) or parse error,
   * so the caller falls back to ratio-based estimation.
   */
  async getSidecar(key: string): Promise<SidecarMeta | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${sidecarKey(key)}` }),
      );
      if (!res.Body) return null;
      return JSON.parse(await res.Body.transformToString()) as SidecarMeta;
    } catch {
      return null;
    }
  }
}

/** A conditional GET that hit the ETag returns 304 — surfaced by the SDK as an
 *  error rather than a result. Match it without depending on one error shape. */
function isNotModified(err: unknown): boolean {
  const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  return e?.$metadata?.httpStatusCode === 304 || e?.name === 'NotModified' || e?.name === '304';
}

function toListed(obj: _Object, prefix: string): ListedObject {
  return {
    key: (obj.Key ?? '').slice(prefix.length), // strip bucket prefix → logical key
    size: obj.Size ?? 0,
    lastModified: obj.LastModified,
    etag: obj.ETag,
  };
}
