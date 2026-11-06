import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, hotp, totp, totpFromKey, totpSecondsLeft } from "./totp";

// RFC 6238 Appendix B: the seeds are the ASCII strings below (20, 32 and 64 bytes), 8 digits, 30 s steps.
const SEED = {
  SHA1: Buffer.from("12345678901234567890", "ascii"),
  SHA256: Buffer.from("12345678901234567890123456789012", "ascii"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii"),
} as const;

const VECTORS: Array<[number, string, string, string]> = [
  // time (s), SHA1, SHA256, SHA512
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("RFC 6238 test vectors, SHA-1, SHA-256 and SHA-512", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    assert.equal(totpFromKey(SEED.SHA1, { at: t * 1000, digits: 8, algorithm: "SHA1" }), sha1, `SHA1 at ${t}`);
    assert.equal(totpFromKey(SEED.SHA256, { at: t * 1000, digits: 8, algorithm: "SHA256" }), sha256, `SHA256 at ${t}`);
    assert.equal(totpFromKey(SEED.SHA512, { at: t * 1000, digits: 8, algorithm: "SHA512" }), sha512, `SHA512 at ${t}`);
  }
});

test("RFC 4226 HOTP vectors (counter 0 to 9)", () => {
  const expect = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expect.forEach((code, i) => assert.equal(hotp(SEED.SHA1, i), code));
});

test("base32 secrets as authenticator setup screens show them", () => {
  // "12345678901234567890" in base32.
  const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.deepEqual(base32Decode(b32), SEED.SHA1);
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), SEED.SHA1);
  assert.equal(totp(b32, { at: 59_000, digits: 8 }), "94287082");
  assert.equal(totp(b32, { at: 59_000 }), "287082");
  assert.throws(() => base32Decode("not-base32!"));
});

test("otpauth links carry digits, period and algorithm", () => {
  const uri = "otpauth://totp/Vendor:ops@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Vendor&digits=8&period=30&algorithm=SHA1";
  assert.equal(totp(uri, { at: 1111111109_000 }), "07081804");
  assert.throws(() => totp("otpauth://totp/x?issuer=y"));
});

test("seconds left in the current step", () => {
  assert.equal(totpSecondsLeft(59_000), 1);
  assert.equal(totpSecondsLeft(60_000), 30);
});
