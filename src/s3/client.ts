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

export class LogBucket {
  private s3: S3Client;
  readonly bucket: string;

  constructor(profile: Profile) {
    this.bucket = profile.bucket;
    this.s3 = new S3Client({
      region: profile.region,
      credentials: {
        accessKeyId: profile.accessKeyId,
        secretAccessKey: profile.secretAccessKey,
        ...(profile.sessionToken ? { sessionToken: profile.sessionToken } : {}),
      },
    });
  }

  /** Top-level prefixes == channels (SPEC §3.2 recipe 1). */
  async listChannels(): Promise<string[]> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Delimiter: '/' }),
    );
    return (res.CommonPrefixes ?? [])
      .map((p) => p.Prefix?.replace(/\/$/, '') ?? '')
      .filter(Boolean);
  }

  /**
   * One paginated listing per channel for a date range (SPEC §3.2 recipe 2):
   * StartAfter positions before the first day; reading stops as soon as keys
   * sort past `{channel}/{endDate}~` (`~` sorts after every interval char).
   */
  async listChannelRange(
    channel: string,
    startDate: string,
    endDate: string,
  ): Promise<ListedObject[]> {
    const prefix = `${channel}/`;
    const stopAt = `${channel}/${endDate}~`;
    const out: ListedObject[] = [];
    let token: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          StartAfter: token ? undefined : `${channel}/${startDate}`,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        if (obj.Key > stopAt) return out;
        out.push(toListed(obj));
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
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
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

function toListed(obj: _Object): ListedObject {
  return {
    key: obj.Key ?? '',
    size: obj.Size ?? 0,
    lastModified: obj.LastModified,
    etag: obj.ETag,
  };
}
