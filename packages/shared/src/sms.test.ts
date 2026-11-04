import assert from "node:assert/strict";
import { test } from "node:test";
import { smsKeyword } from "./sms";

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
});
