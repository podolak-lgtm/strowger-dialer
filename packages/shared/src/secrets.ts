// Small symmetric-crypto helpers shared by web and engine. Both hold
// ENGINE_INTERNAL_KEY; everything here derives from it.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM. Output: base64url(iv).base64url(tag).base64url(ciphertext). */
export function encryptString(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decryptString(blob: string, secret: string): string | null {
  const [iv, tag, ct] = blob.split(".");
  if (!iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function randomPassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

/** Short-lived HMAC token for the realtime socket. */
export interface RealtimeAuth {
  tenantId: string;
  userId: string;
  roles: string[];
}

export function mintRealtimeToken(auth: RealtimeAuth, secret: string, ttlSeconds = 600): string {
  const payload = Buffer.from(JSON.stringify({ ...auth, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyRealtimeToken(token: string, secret: string): RealtimeAuth | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as RealtimeAuth & { exp: number };
    if (data.exp < Date.now()) return null;
    return { tenantId: data.tenantId, userId: data.userId, roles: data.roles };
  } catch {
    return null;
  }
}

/** SIP digest (RFC 2617) check, as the registration hook needs it. */
export function sipDigestMatches(input: {
  username: string;
  realm: string;
  password: string;
  method: string;
  uri: string;
  nonce: string;
  response: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
  algorithm?: string;
}): boolean {
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const ha1 = md5(`${input.username}:${input.realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const expected =
    input.qop && input.nc && input.cnonce
      ? md5(`${ha1}:${input.nonce}:${input.nc}:${input.cnonce}:${input.qop}:${ha2}`)
      : md5(`${ha1}:${input.nonce}:${ha2}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.response.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}
