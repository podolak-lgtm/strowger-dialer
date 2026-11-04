import assert from "node:assert/strict";
import { test } from "node:test";
import { AREA_CODE_STATE, resolveZone, stateForAreaCode, stateForZip } from "./index.js";

test("zip prefixes map to states", () => {
  assert.equal(stateForZip("10001"), "NY");
  assert.equal(stateForZip("33101-1234"), "FL");
  assert.equal(stateForZip("90210"), "CA");
  assert.equal(stateForZip("20500"), "DC");
  assert.equal(stateForZip("99501"), "AK");
  assert.equal(stateForZip("1234"), null);
});

test("every area code in the table is three digits and maps to a zoned state", () => {
  for (const [code, state] of Object.entries(AREA_CODE_STATE)) {
    assert.match(code, /^\d{3}$/);
    assert.ok(resolveZone({ phone: `${code}5551234` }), `${code} ${state}`);
  }
});

test("zip wins over a conflicting area code for the state", () => {
  const r = resolveZone({ zip: "60601", phone: "2125551234" });
  assert.equal(r?.state, "IL");
  assert.equal(r?.timezone, "America/Chicago");
  assert.equal(r?.basis, "zip");
  assert.equal(r?.confidence, "high");
});

test("area code decides the side of a split state", () => {
  assert.equal(resolveZone({ zip: "32501", phone: "8505551234" })?.timezone, "America/Chicago"); // Pensacola
  assert.equal(resolveZone({ zip: "33101", phone: "3055551234" })?.timezone, "America/New_York"); // Miami
  assert.equal(resolveZone({ zip: "79901", phone: "9155551234" })?.timezone, "America/Denver"); // El Paso
  assert.equal(resolveZone({ zip: "42101", phone: "2705551234" })?.timezone, "America/Chicago"); // Bowling Green
  assert.equal(resolveZone({ zip: "37902", phone: "8655551234" })?.timezone, "America/New_York"); // Knoxville
});

test("falls back to state, then area code, with lower confidence", () => {
  assert.deepEqual(resolveZone({ state: "az" }), {
    timezone: "America/Phoenix",
    state: "AZ",
    basis: "state",
    confidence: "medium",
  });
  const byPhone = resolveZone({ phone: "2065551234" });
  assert.equal(byPhone?.state, "WA");
  assert.equal(byPhone?.basis, "area_code");
  assert.equal(byPhone?.confidence, "medium");
  assert.equal(resolveZone({ phone: "8125551234" })?.confidence, "low");
  assert.equal(resolveZone({}), null);
  assert.equal(stateForAreaCode("000"), null);
});
