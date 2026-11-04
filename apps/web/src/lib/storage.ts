// Object storage for audio prompts (and anything else we host ourselves).
// S3-compatible; on Railway the bucket's variables are referenced, not
// copied. Files are served through /api/media/<key> so the bucket can stay
// private.
import "server-only";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const storageConfigured = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "auto",
      forcePathStyle: (process.env.S3_URL_STYLE ?? "path") !== "virtual",
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" },
    });
  }
  return client;
}

export async function putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function getObject(key: string): Promise<{ body: ReadableStream | null; contentType: string | null; length: number | null } | null> {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return { body: (r.Body as { transformToWebStream?: () => ReadableStream } | undefined)?.transformToWebStream?.() ?? null, contentType: r.ContentType ?? null, length: r.ContentLength ?? null };
  } catch {
    return null;
  }
}

/** Public URL the dialer (jambonz) fetches prompts from. */
export function mediaUrl(key: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://web-production-c3af0.up.railway.app";
  return `${base}/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}
