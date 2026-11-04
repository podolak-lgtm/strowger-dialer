import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decryptString, encryptString, mintRealtimeToken, sipDigestMatches, verifyRealtimeToken } from "./secrets";

const SECRET = "0123456789abcdef0123456789abcdef";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

test("encrypt/decrypt round-trips and rejects a wrong key", () => {
  const blob = encryptString("pw-secret-1", SECRET);
  assert.equal(decryptString(blob, SECRET), "pw-secret-1");
  assert.equal(decryptString(blob, "another-key-another-key-another-k"), null);
  assert.equal(decryptString("garbage", SECRET), null);
});

test("realtime token verifies, and expires", () => {
  const t = mintRealtimeToken({ tenantId: "t1", userId: "u1", roles: ["AGENT"] }, SECRET, 60);
  assert.deepEqual(verifyRealtimeToken(t, SECRET), { tenantId: "t1", userId: "u1", roles: ["AGENT"] });
  assert.equal(verifyRealtimeToken(t, "wrong-secret-wrong-secret-wrong-s"), null);
  const expired = mintRealtimeToken({ tenantId: "t1", userId: "u1", roles: [] }, SECRET, -1);
  assert.equal(verifyRealtimeToken(expired, SECRET), null);
});

test("sip digest check, with and without qop", () => {
  const base = { username: "agent1", realm: "r.example", password: "pw", method: "REGISTER", uri: "sip:r.example", nonce: "n1" };
  const ha1 = md5("agent1:r.example:pw");
  const ha2 = md5("REGISTER:sip:r.example");
  assert.equal(sipDigestMatches({ ...base, response: md5(`${ha1}:n1:${ha2}`) }), true);
  assert.equal(sipDigestMatches({ ...base, response: md5(`${ha1}:n1:00000001:cn:auth:${ha2}`), qop: "auth", nc: "00000001", cnonce: "cn" }), true);
  assert.equal(sipDigestMatches({ ...base, response: "00" }), false);
  assert.equal(sipDigestMatches({ ...base, password: "other", response: md5(`${ha1}:n1:${ha2}`) }), false);
});
