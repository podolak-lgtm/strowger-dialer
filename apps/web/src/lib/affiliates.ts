// Affiliate API keys: generated once, shown once, stored hashed.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma, type Affiliate } from "@strowger/db";

export function generateApiKey(): { plain: string; hash: string; hint: string } {
  const plain = `sk_live_${randomBytes(24).toString("base64url")}`;
  return { plain, hash: hashApiKey(plain), hint: `${plain.slice(0, 8)}…${plain.slice(-4)}` };
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Resolve a bearer token to its affiliate, or null. Constant-time on the hash compare. */
export async function affiliateForKey(bearer: string | null | undefined): Promise<Affiliate | null> {
  if (!bearer) return null;
  const hash = hashApiKey(bearer.trim());
  const row = await prisma.affiliate.findUnique({ where: { apiKeyHash: hash } });
  if (!row || !row.active) return null;
  const a = Buffer.from(row.apiKeyHash);
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

/** Apply an affiliate's field mapping (their names -> ours) to a raw payload. */
export function applyFieldMapping(payload: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const [theirs, ours] of Object.entries(mapping)) {
    if (theirs in payload && !(ours in payload)) {
      out[ours] = payload[theirs];
      delete out[theirs];
    }
  }
  return out;
}
