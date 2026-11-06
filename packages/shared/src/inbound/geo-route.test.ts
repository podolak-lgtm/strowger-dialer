import assert from "node:assert/strict";
import { test } from "node:test";
import { callerGeo, matchGeoRoute, parseAreaCodes, parseStates } from "./geo-route";

const rules = [
  { id: "texas", states: ["TX", "OK"], areaCodes: [], targetQueueId: "q-south", isFallback: false, sortOrder: 1 },
  { id: "austin", states: [], areaCodes: ["512", "737"], targetQueueId: "q-austin", isFallback: false, sortOrder: 5 },
  { id: "rest", states: [], areaCodes: [], targetQueueId: "q-main", isFallback: true, sortOrder: 0 },
  { id: "ny", states: ["NY"], areaCodes: [], targetQueueId: "q-east", isFallback: false, sortOrder: 2 },
];

test("an area-code rule beats a state rule for the same caller", () => {
  assert.equal(matchGeoRoute(rules, { state: "TX", areaCode: "512" })?.id, "austin");
  assert.equal(matchGeoRoute(rules, { state: "TX", areaCode: "214" })?.id, "texas");
});

test("the fallback catches everyone else; no fallback means no match", () => {
  assert.equal(matchGeoRoute(rules, { state: "CA", areaCode: "415" })?.id, "rest");
  assert.equal(matchGeoRoute(rules, { state: null, areaCode: null })?.id, "rest");
  assert.equal(matchGeoRoute(rules.filter((r) => !r.isFallback), { state: "CA", areaCode: "415" }), null);
});

test("the caller's state comes from the lead when known, else the number", () => {
  assert.deepEqual(callerGeo("5125550100"), { state: "TX", areaCode: "512" });
  assert.deepEqual(callerGeo("+1 (212) 555-0100"), { state: "NY", areaCode: "212" });
  // A Texan number on a lead who lives in Florida (ZIP decides): routed as Florida, but the area code still matches area-code rules.
  assert.deepEqual(callerGeo("5125550100", { state: "FL", zip: "33101" }), { state: "FL", areaCode: "512" });
  assert.equal(matchGeoRoute(rules, callerGeo("2125550100"))?.id, "ny");
  assert.deepEqual(callerGeo(null), { state: null, areaCode: null });
});

test("admin text boxes parse states and area codes", () => {
  assert.deepEqual(parseStates("tx, ok ,LA Texas"), ["TX", "OK", "LA"]);
  assert.deepEqual(parseAreaCodes("512 737,9999, 212"), ["512", "737", "212"]);
});
