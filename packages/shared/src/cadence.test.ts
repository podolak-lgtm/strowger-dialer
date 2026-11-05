import assert from "node:assert/strict";
import { test } from "node:test";
import { daypartOf, instantAtLocal, localParts, nextAttemptAt, parseDayparts, renderTemplate } from "./cadence";

const NY = "America/New_York";

test("dayparts classify local hours", () => {
  assert.equal(daypartOf(9), "MORNING");
  assert.equal(daypartOf(11.5), null); // end exclusive, between windows
  assert.equal(daypartOf(13), "AFTERNOON");
  assert.equal(daypartOf(19.25), "EVENING");
  assert.equal(daypartOf(21), null);
});

test("parseDayparts keeps defaults for bad input", () => {
  const w = parseDayparts({ MORNING: [9, 12], AFTERNOON: "nope" });
  assert.deepEqual(w.MORNING, [9, 12]);
  assert.deepEqual(w.AFTERNOON, [12.5, 16.5]);
});

test("instantAtLocal lands on the local wall clock", () => {
  // 2026-11-04 15:00Z is 10:00 New York (EST, UTC-5)
  const now = new Date("2026-11-04T15:00:00Z");
  const at = instantAtLocal(NY, now, 17);
  assert.equal(localParts(NY, at)?.hourFrac, 17);
  assert.equal(at.toISOString(), "2026-11-04T22:00:00.000Z");
  const tomorrow = instantAtLocal(NY, now, 8.5, 1);
  assert.equal(tomorrow.toISOString(), "2026-11-05T13:30:00.000Z");
});

test("rotation: after a morning attempt the next slot is the afternoon window", () => {
  const now = new Date("2026-11-04T15:00:00Z"); // 10:00 NY
  const next = nextAttemptAt({ zone: NY, now, lastAttemptAt: now, lastDaypart: "MORNING", minGapMinutes: 60, rotateDayparts: true });
  assert.equal(next.toISOString(), "2026-11-04T17:30:00.000Z"); // 12:30 NY
});

test("rotation: evening attempt rolls to next morning, never the same window", () => {
  const now = new Date("2026-11-05T00:00:00Z"); // 19:00 NY Wed
  const next = nextAttemptAt({ zone: NY, now, lastAttemptAt: now, lastDaypart: "EVENING", minGapMinutes: 240, rotateDayparts: true });
  assert.equal(next.toISOString(), "2026-11-05T13:30:00.000Z"); // 08:30 NY Thu
});

test("minimum gap pushes into a later window", () => {
  const now = new Date("2026-11-04T15:00:00Z"); // 10:00 NY
  const next = nextAttemptAt({ zone: NY, now, lastAttemptAt: now, lastDaypart: "MORNING", minGapMinutes: 8 * 60, rotateDayparts: true });
  // gap ends 18:00 NY -> inside EVENING window (17:00–19:30) -> dial at gap end
  assert.equal(next.toISOString(), "2026-11-04T23:00:00.000Z");
});

test("without rotation the gap alone decides", () => {
  const now = new Date("2026-11-04T15:00:00Z");
  const next = nextAttemptAt({ zone: NY, now, lastAttemptAt: now, lastDaypart: null, minGapMinutes: 240, rotateDayparts: false });
  assert.equal(next.toISOString(), "2026-11-04T19:00:00.000Z");
});

test("templates render and blank unknown keys", () => {
  assert.equal(renderTemplate("Hi {{first_name}}, call from {{ caller_id_number }} {{nope}}", { first_name: "Ada", caller_id_number: "(305) 555-0100" }), "Hi Ada, call from (305) 555-0100 ");
  assert.equal(renderTemplate("Lead {{lead.firstName}} {{ lead.lastName }}", { "lead.firstName": "Ada", "lead.lastName": "Lovelace" }), "Lead Ada Lovelace");
});
