import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateSchedule, localParts, parseClock, parseHolidays, parseRangesText, parseWeekly, rangesText, withinWeeklyHours, type ScheduleDef } from "./schedule";

// 2026-11-06 is a Friday. New York is UTC-5 after 1 Nov.
const weekdays9to5 = { "1": [["09:00", "17:00"]], "2": [["09:00", "17:00"]], "3": [["09:00", "17:00"]], "4": [["09:00", "17:00"]], "5": [["09:00", "17:00"]] } as const;
const ny: ScheduleDef = { timezone: "America/New_York", weekly: weekdays9to5 };

test("parseClock accepts HH:MM and 24:00, refuses junk", () => {
  assert.equal(parseClock("09:30"), 570);
  assert.equal(parseClock("9:05"), 545);
  assert.equal(parseClock("24:00"), 1440);
  assert.equal(parseClock("24:01"), null);
  assert.equal(parseClock("12:60"), null);
  assert.equal(parseClock("noon"), null);
});

test("open inside the day's range in the schedule's own zone", () => {
  assert.deepEqual(evaluateSchedule(ny, new Date("2026-11-06T15:00:00Z")), { open: true }); // 10:00 NY
  assert.equal(evaluateSchedule(ny, new Date("2026-11-06T22:00:00Z")).open, false); // 17:00 NY: end is exclusive
  assert.equal(evaluateSchedule(ny, new Date("2026-11-06T13:59:00Z")).open, false); // 08:59 NY
});

test("the same instant is open in one zone and closed in another", () => {
  const at = new Date("2026-11-06T16:30:00Z"); // 11:30 NY, 08:30 LA
  assert.equal(evaluateSchedule(ny, at).open, true);
  assert.equal(evaluateSchedule({ ...ny, timezone: "America/Los_Angeles" }, at).open, false);
});

test("a missing weekday is closed all day", () => {
  const s = evaluateSchedule(ny, new Date("2026-11-07T16:00:00Z")); // Saturday 11:00
  assert.equal(s.open, false);
  if (!s.open) assert.equal(s.reason, "hours");
});

test("overnight ranges run into the next morning", () => {
  const weekly = { "5": [["22:00", "02:00"]] } as const; // Friday night
  assert.equal(withinWeeklyHours(weekly, 5, 23 * 60), true);
  assert.equal(withinWeeklyHours(weekly, 6, 60), true); // Saturday 01:00
  assert.equal(withinWeeklyHours(weekly, 6, 2 * 60), false); // Saturday 02:00, end exclusive
  assert.equal(withinWeeklyHours(weekly, 5, 60), false); // Friday 01:00 belongs to Thursday's range
  const s: ScheduleDef = { timezone: "America/Chicago", weekly };
  assert.equal(evaluateSchedule(s, new Date("2026-11-07T07:30:00Z")).open, true); // Sat 01:30 Chicago
});

test("24:00 closes at midnight and several ranges per day work", () => {
  const weekly = { "5": [["08:00", "12:00"], ["13:00", "24:00"]] } as const;
  assert.equal(withinWeeklyHours(weekly, 5, 12 * 60 + 30), false);
  assert.equal(withinWeeklyHours(weekly, 5, 23 * 60 + 59), true);
  assert.equal(withinWeeklyHours(weekly, 6, 0), false);
});

test("a holiday closes the whole local day and carries its message", () => {
  const s = evaluateSchedule({ ...ny, holidays: [{ date: "2026-11-26", name: "Thanksgiving", audioId: "a1" }] }, new Date("2026-11-26T16:00:00Z"));
  assert.equal(s.open, false);
  if (!s.open && s.reason === "holiday") {
    assert.equal(s.holiday.name, "Thanksgiving");
    assert.equal(s.audioId, "a1");
  } else assert.fail("expected a holiday");
  // The local date decides: 03:00Z on the 27th is still the 26th in New York.
  assert.equal(evaluateSchedule({ ...ny, weekly: { "4": [["00:00", "24:00"]] }, holidays: [{ date: "2026-11-26" }] }, new Date("2026-11-27T03:00:00Z")).open, false);
});

test("the manual override closes until its end, then the hours apply again", () => {
  const at = new Date("2026-11-06T15:00:00Z");
  const closed = evaluateSchedule({ ...ny, closedNow: true, closedUntil: new Date("2026-11-06T16:00:00Z"), closedNowAudioId: "msg" }, at);
  assert.deepEqual(closed, { open: false, reason: "override", audioId: "msg" });
  assert.equal(evaluateSchedule({ ...ny, closedNow: true, closedUntil: "2026-11-06T14:00:00Z" }, at).open, true);
  assert.equal(evaluateSchedule({ ...ny, closedNow: true, closedUntil: null }, at).open, false);
});

test("an unknown zone is closed, never guessed", () => {
  const s = evaluateSchedule({ ...ny, timezone: "Mars/Olympus" }, new Date());
  assert.equal(s.open, false);
  if (!s.open) assert.equal(s.reason, "timezone");
});

test("localParts reports date, weekday and minutes", () => {
  assert.deepEqual(localParts("America/New_York", new Date("2026-11-06T15:07:00Z")), { date: "2026-11-06", weekday: 5, minutes: 10 * 60 + 7 });
});

test("range text round-trips and junk is dropped", () => {
  const r = parseRangesText("9:00-17:00, 18:00 – 20:30; nonsense, 25:00-26:00");
  assert.deepEqual(r, [["09:00", "17:00"], ["18:00", "20:30"]]);
  assert.equal(rangesText(r), "09:00-17:00, 18:00-20:30");
});

test("stored JSON is read defensively", () => {
  assert.deepEqual(parseWeekly({ "1": [["09:00", "17:00"]], "9": [["x", "y"]], "2": "bad" }), { "1": [["09:00", "17:00"]] });
  assert.deepEqual(parseHolidays([{ date: "2026-12-25", name: "Christmas" }, { date: "Dec 25" }, null]), [{ date: "2026-12-25", name: "Christmas", audioId: null }]);
});

test("a wall-clock time in the schedule's zone converts to UTC and back", async () => {
  const { zonedTimeToUtc, utcToZonedInput } = await import("./schedule");
  assert.equal(zonedTimeToUtc("2026-11-26T17:30", "America/New_York")?.toISOString(), "2026-11-26T22:30:00.000Z");
  assert.equal(zonedTimeToUtc("2026-07-04T09:00", "America/Los_Angeles")?.toISOString(), "2026-07-04T16:00:00.000Z");
  assert.equal(utcToZonedInput(new Date("2026-11-26T22:30:00Z"), "America/New_York"), "2026-11-26T17:30");
  assert.equal(zonedTimeToUtc("tomorrow", "America/New_York"), null);
  assert.equal(zonedTimeToUtc("2026-11-26T17:30", "Mars/Olympus"), null);
});
