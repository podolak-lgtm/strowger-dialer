import assert from "node:assert/strict";
import { test } from "node:test";
import { missingPostFields, normalizeLead } from "./intake";

test("normalises a full posted lead", () => {
  const r = normalizeLead({
    first_name: " Ada ",
    last_name: "Lovelace",
    phone: "+1 (305) 555-2368",
    address: "1 Ocean Dr",
    city: "Miami",
    state: "fl",
    zip: "33139-1234",
    email: "ADA@Example.com",
    jornaya_lead_id: "abc",
    trustedform_cert_url: "https://cert.trustedform.com/xyz",
    opt_in_url: "https://example.com/form",
    opt_in_at: "2026-11-01T12:00:00Z",
    opt_in_ip: "1.2.3.4",
    source_campaign: "fb-123",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.lead.phone, "3055552368");
  assert.equal(r.lead.firstName, "Ada");
  assert.equal(r.lead.state, "FL");
  assert.equal(r.lead.zip, "33139");
  assert.equal(r.lead.email, "ada@example.com");
  assert.equal(r.lead.optInAt?.toISOString(), "2026-11-01T12:00:00.000Z");
  assert.deepEqual(r.lead.custom, { source_campaign: "fb-123" });
  assert.deepEqual(missingPostFields(r.lead), []);
});

test("rejects a bad phone", () => {
  const r = normalizeLead({ phone: "555-0100" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad_phone");
});

test("accepts unix timestamps for opt_in_at and lists missing post fields", () => {
  const r = normalizeLead({ phone: 2125552368, opt_in_at: "1761998400" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.lead.optInAt?.getUTCFullYear(), 2025);
  assert.deepEqual(missingPostFields(r.lead), ["first_name", "last_name", "address", "city", "state", "zip", "opt_in_url"]);
});

test("drops an email that is not one", () => {
  const r = normalizeLead({ phone: "2125552368", email: "not-an-email" });
  assert.ok(r.ok && r.lead.email === null);
});
