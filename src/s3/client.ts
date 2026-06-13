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
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = await gunzip(bytes);
    }
    return bytes;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function toListed(obj: _Object, prefix: string): ListedObject {
  return {
    key: (obj.Key ?? '').slice(prefix.length), // strip bucket prefix → logical key
    size: obj.Size ?? 0,
    lastModified: obj.LastModified,
    etag: obj.ETag,
  };
}
