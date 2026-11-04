import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackDue, decideReplyAction, smsKeyword } from "./sms";

test("stop words in any case and with punctuation", () => {
  assert.equal(smsKeyword("STOP"), "STOP");
  assert.equal(smsKeyword("Stop!"), "STOP");
  assert.equal(smsKeyword("unsubscribe"), "STOP");
  assert.equal(smsKeyword("please stop texting me"), "STOP");
});

test("help, start, and ordinary replies", () => {
  assert.equal(smsKeyword("HELP"), "HELP");
  assert.equal(smsKeyword("start"), "START");
  assert.equal(smsKeyword("yes call me at 3"), null);
  assert.equal(smsKeyword(""), null);
  assert.equal(smsKeyword("don't call me again"), null); // the AI read catches this one
});

test("AI opt-out above the threshold is applied, below it is flagged for review", () => {
  assert.equal(decideReplyAction({ intent: "OPT_OUT", confidence: 0.95, callback_at: null }, 0.8), "opt_out");
  assert.equal(decideReplyAction({ intent: "OPT_OUT", confidence: 0.5, callback_at: null }, 0.8), "review");
  assert.equal(decideReplyAction({ intent: "NOT_INTERESTED", confidence: 0.99, callback_at: null }, 0.8), "none");
  assert.equal(decideReplyAction(null, 0.8), "none");
});

test("callback requests book a callback only when confident", () => {
  assert.equal(decideReplyAction({ intent: "CALLBACK_REQUEST", confidence: 0.9, callback_at: null }, 0.8), "callback");
  assert.equal(decideReplyAction({ intent: "CALLBACK_REQUEST", confidence: 0.3, callback_at: null }, 0.8), "none");
});

test("callback time defaults to soon and is clamped to the next two weeks", () => {
  const now = new Date("2026-11-04T15:00:00Z");
  assert.equal(callbackDue(null, now).toISOString(), "2026-11-04T15:15:00.000Z");
  assert.equal(callbackDue("2026-11-04T10:00:00Z", now).toISOString(), "2026-11-04T15:15:00.000Z");
  assert.equal(callbackDue("2026-11-05T18:00:00Z", now).toISOString(), "2026-11-05T18:00:00.000Z");
  assert.equal(callbackDue("2027-06-01T18:00:00Z", now).toISOString(), "2026-11-18T15:00:00.000Z");
  assert.equal(callbackDue("garbage", now).toISOString(), "2026-11-04T15:15:00.000Z");
});
