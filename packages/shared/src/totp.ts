// RFC 6238 time-based one-time passwords (the six digits an authenticator app
// shows), from the base32 secret a vendor shows when two-factor sign-in is set
// up. Used by the vendor browser connectors (apps/engine/src/billing/vendors)
// so a nightly sign-in can answer an authenticator prompt with no person.
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (spaces, dashes and padding ignored; case-insensitive). Throws on a character outside the alphabet. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("The authenticator secret is not base32 (letters A-Z and digits 2-7)");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP for a counter. */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = "SHA1"): string {
  const msg = Buffer.alloc(8);
  // Counters past 2^32 (TOTP after 2106 at 30 s steps, or the RFC's year-2603 vector) need both halves.
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions {
  /** Unix time in milliseconds; default now. */
  at?: number;
  step?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

/** The code for a raw key (bytes). */
export function totpFromKey(key: Buffer, o: TotpOptions = {}): string {
  const step = o.step ?? 30;
  return hotp(key, Math.floor((o.at ?? Date.now()) / 1000 / step), o.digits ?? 6,o.algorithm ?? "SHA1");
}

/**
 * The code for a secret as vendors show it: base32, or an otpauth:// URI (its secret, digits, period and
 * algorithm are honoured).
 */
export function totp(secretOrUri: string, o: TotpOptions = {}): string {
  const s = secretOrUri.trim();
  if (/^otpauth:\/\//i.test(s)) {
    const u = new URL(s);
    const secret = u.searchParams.get("secret");
    if (!secret) throw new Error("The otpauth link has no secret");
    const alg = (u.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    return totpFromKey(base32Decode(secret), {
      ...o,
      digits: o.digits ?? (Number(u.searchParams.get("digits")) || 6),
      step: o.step ?? (Number(u.searchParams.get("period")) || 30),
      algorithm: o.algorithm ?? (alg === "SHA256" || alg === "SHA512" ? alg : "SHA1"),
    });
  }
  return totpFromKey(base32Decode(s), o);
}

/** Seconds left before the current code changes: a code with under a few seconds left is better waited out. */
export function totpSecondsLeft(at = Date.now(), step = 30): number {
  return step - (Math.floor(at / 1000) % step);
}
