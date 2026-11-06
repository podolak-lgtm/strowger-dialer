import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestPhones, readTestPhones, testPhoneActive, turnOnTestPhones, TEST_PHONES_MAX } from "./test-phones";
import { evaluateDialWindow } from "./window";

const NOW = new Date("2026-11-07T03:30:00Z"); // 22:30 New York: past the federal 21:00 end

test("parseTestPhones keeps unique ten-digit numbers and caps the list", () => {
  assert.deepEqual(parseTestPhones("(561) 271-8275, +1 561 271 8275\n4303820938 123"), ["5612718275", "4303820938"]);
  const many = Array.from({ length: 15 }, (_, i) => `55512300${String(i).padStart(2, "0")}`).join(" ");
  assert.equal(parseTestPhones(many).length, TEST_PHONES_MAX);
});

test("the switch lasts 12 hours and only covers listed phones", () => {
  const settings = { testPhones: turnOnTestPhones(["5612718275"], NOW) };
  assert.equal(testPhoneActive(settings, "+15612718275", NOW), true);
  assert.equal(testPhoneActive(settings, "5615550000", NOW), false);
  assert.equal(testPhoneActive(settings, "5612718275", new Date(NOW.getTime() + 11.9 * 3600_000)), true);
  assert.equal(testPhoneActive(settings, "5612718275", new Date(NOW.getTime() + 12 * 3600_000)), false);
});

test("malformed or missing settings are off", () => {
  assert.equal(readTestPhones(null), null);
  assert.equal(readTestPhones({ testPhones: { phones: "5612718275", until: "x" } }), null);
  assert.equal(testPhoneActive({}, "5612718275", NOW), false);
});

test("a test phone dials past the calling window; any other number does not", () => {
  const base = { timezone: "America/New_York", state: "FL", campaignStartHour: 9, campaignEndHour: 20, attemptsAllowedPerDay: 3, attemptsToday: 5, now: NOW };
  assert.equal(evaluateDialWindow(base).allowed, false);
  assert.equal(evaluateDialWindow({ ...base, testPhone: true }).allowed, true);
  // The time zone is still required.
  assert.equal(evaluateDialWindow({ ...base, timezone: null, testPhone: true }).allowed, false);
});

test("always-on test phones never expire and still cover only the list", () => {
  const settings = { testPhones: turnOnTestPhones(["5612718275", "4303821338"], NOW, true) };
  const later = new Date(NOW.getTime() + 400 * 24 * 3600_000);
  assert.equal(testPhoneActive(settings, "4303821338", later), true);
  assert.equal(testPhoneActive(settings, "4303820938", later), false);
  assert.deepEqual(readTestPhones(settings)?.always, true);
});
