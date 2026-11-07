import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDialWindow, localTimeIn } from "./window";

// 2026-11-04 is a Wednesday. 18:30Z = 13:30 New York, 10:30 Los Angeles.
const WED_1830Z = new Date("2026-11-04T18:30:00Z");
// 2026-11-08 is a Sunday. 15:00Z = 09:00 Chicago.
const SUN_1500Z = new Date("2026-11-08T15:00:00Z");

const base = {
  campaignStartHour: 9,
  campaignEndHour: 20,
  attemptsAllowedPerDay: 3,
  attemptsToday: 0,
};

test("localTimeIn resolves hour and weekday", () => {
  assert.deepEqual(localTimeIn("America/New_York", WED_1830Z), { hour: 13, weekday: 3, date: "2026-11-04" });
  assert.equal(localTimeIn("Not/AZone", WED_1830Z), null);
});

test("allows a weekday afternoon in a state with no special rule", () => {
  const d = evaluateDialWindow({ ...base, timezone: "America/New_York", state: "OH", now: WED_1830Z });
  assert.equal(d.allowed, true);
});

test("refuses when the lead's zone is unknown", () => {
  const d = evaluateDialWindow({ ...base, timezone: null, state: "OH", now: WED_1830Z });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.rule, "timezone");
});

test("state cap on attempts beats the campaign's allowance", () => {
  const d = evaluateDialWindow({
    ...base,
    attemptsAllowedPerDay: 5,
    attemptsToday: 3,
    timezone: "America/New_York",
    state: "FL",
    now: WED_1830Z,
  });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.rule, /FTSA/);
});

test("Florida closes at 8pm even if the campaign runs to 9", () => {
  const eveningFl = new Date("2026-11-05T01:30:00Z"); // 20:30 New York, Wed
  const d = evaluateDialWindow({
    ...base,
    campaignEndHour: 21,
    timezone: "America/New_York",
    state: "FL",
    now: eveningFl,
  });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.localHour, 20);
});

test("Mississippi refuses Sundays outright", () => {
  const d = evaluateDialWindow({ ...base, timezone: "America/Chicago", state: "MS", now: SUN_1500Z });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /weekday/);
});

test("Texas Sunday starts at noon", () => {
  const d = evaluateDialWindow({ ...base, timezone: "America/Chicago", state: "TX", now: SUN_1500Z });
  assert.equal(d.allowed, false); // 09:00 local, Sunday
  const later = new Date("2026-11-08T18:30:00Z"); // 12:30 Chicago
  assert.equal(evaluateDialWindow({ ...base, timezone: "America/Chicago", state: "TX", now: later }).allowed, true);
});

test("federal 8am floor applies when the campaign asks for earlier", () => {
  const earlyZ = new Date("2026-11-04T12:30:00Z"); // 07:30 New York
  const d = evaluateDialWindow({ ...base, campaignStartHour: 7, timezone: "America/New_York", state: "OH", now: earlyZ });
  assert.equal(d.allowed, false);
});

test("campaign schedule grid can close an hour the window allows", () => {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => h >= 9 && h < 20));
  grid[3]![13] = false; // Wednesday 1pm off
  const d = evaluateDialWindow({ ...base, allowedHours: grid, timezone: "America/New_York", state: "OH", now: WED_1830Z });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.rule, "campaign schedule grid");
  grid[3]![13] = true;
  assert.equal(evaluateDialWindow({ ...base, allowedHours: grid, timezone: "America/New_York", state: "OH", now: WED_1830Z }).allowed, true);
  assert.equal(evaluateDialWindow({ ...base, allowedHours: [[1]], timezone: "America/New_York", state: "OH", now: WED_1830Z }).allowed, true);
});
