import assert from "node:assert/strict";
import { test } from "node:test";
import { easter, holidayDates, holidayOn } from "./holidays";
import { evaluateDialWindow } from "./window";

const base = { campaignStartHour: 8, campaignEndHour: 21, attemptsAllowedPerDay: 10, attemptsToday: 0 };

test("holiday dates for 2026", () => {
  assert.deepEqual(easter(2026), [4, 5]);
  const d = holidayDates(["THANKSGIVING", "GOOD_FRIDAY", "MARDI_GRAS", "MEMORIAL", "LABOR", "ELECTION_DAY", "MLK"], 2026);
  for (const x of ["2026-11-26", "2026-04-03", "2026-02-17", "2026-05-25", "2026-09-07", "2026-11-03", "2026-01-19"]) assert.ok(d.has(x), x);
});

test("a weekend fixed-date holiday also blocks its observed weekday", () => {
  // 4 July 2026 is a Saturday: Friday 3 July is observed.
  assert.equal(holidayOn(["INDEPENDENCE"], "2026-07-03"), "INDEPENDENCE");
  assert.equal(holidayOn(["INDEPENDENCE"], "2026-07-06"), null);
  // 1 Jan 2028 is a Saturday: Friday 31 Dec 2027 is observed.
  assert.equal(holidayOn(["NEW_YEAR"], "2027-12-31"), "NEW_YEAR");
});

test("Louisiana: no calls on Christmas Day, calls the day after", () => {
  const xmas = evaluateDialWindow({ ...base, timezone: "America/Chicago", state: "LA", now: new Date("2026-12-25T16:00:00Z") });
  assert.equal(xmas.allowed, false);
  const after = evaluateDialWindow({ ...base, timezone: "America/Chicago", state: "LA", now: new Date("2026-12-28T16:00:00Z") });
  assert.equal(after.allowed, true);
});

test("Pennsylvania (Act 47 of 2026): 9am-7pm, Saturday mornings only, no Sundays", () => {
  const ny = "America/New_York";
  // Wednesday 4 Nov 2026: 18:30 local allowed, 19:30 refused.
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-04T23:30:00Z") }).allowed, true);
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-05T00:30:00Z") }).allowed, false);
  // Saturday 7 Nov 2026: 10:00 allowed, 13:00 refused.
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-07T15:00:00Z") }).allowed, true);
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-07T18:00:00Z") }).allowed, false);
  // Sunday 8 Nov 2026 at noon: refused.
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-08T17:00:00Z") }).allowed, false);
  // Veterans Day, Wednesday 11 Nov 2026: refused.
  assert.equal(evaluateDialWindow({ ...base, timezone: ny, state: "PA", now: new Date("2026-11-11T16:00:00Z") }).allowed, false);
});

test("Oregon: 8pm cutoff and 3 attempts a day", () => {
  const la = "America/Los_Angeles";
  assert.equal(evaluateDialWindow({ ...base, timezone: la, state: "OR", now: new Date("2026-11-05T04:30:00Z") }).allowed, false); // 20:30 local
  assert.equal(evaluateDialWindow({ ...base, timezone: la, state: "OR", attemptsToday: 3, now: new Date("2026-11-04T20:00:00Z") }).allowed, false);
});

test("Mississippi: 8pm cutoff and no Sundays", () => {
  const ch = "America/Chicago";
  assert.equal(evaluateDialWindow({ ...base, timezone: ch, state: "MS", now: new Date("2026-11-05T02:30:00Z") }).allowed, false); // 20:30 local Wed
  assert.equal(evaluateDialWindow({ ...base, timezone: ch, state: "MS", now: new Date("2026-11-08T17:00:00Z") }).allowed, false); // Sunday
});
