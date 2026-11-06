// Vendor invoices and failure screenshots in the media bucket. Keys start with
// vendor-invoices/ or vendor-screens/, which the public /api/media route refuses;
// the platform page fetches them through /api/platform/vendor-file (admins only).
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../../config";

export const bucketConfigured = Boolean(config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY);

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION || "auto", forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY_ID ?? "", secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? "" } });
  return client;
}

/** Store a file; returns its key, or null when the bucket is not configured (the run carries on without the copy). */
export async function putVendorFile(key: string, body: Buffer, contentType: string): Promise<string | null> {
  if (!bucketConfigured) return null;
  await s3().send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getVendorFile(key: string): Promise<Buffer | null> {
  if (!bucketConfigured) return null;
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    const bytes = await r.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}
