import assert from "node:assert/strict";
import { test } from "node:test";
import { detectScreener } from "./screener";

test("matches known screening prompts", () => {
  assert.equal(detectScreener("Hi, the person you're calling is using a screening service from Google. Say your name and why you're calling.").matched, true);
  assert.equal(detectScreener("Who's calling and why?").matched, true);
  assert.equal(detectScreener("Can you tell me what this call is about?").matched, true);
});

test("does not match an ordinary greeting", () => {
  assert.equal(detectScreener("Hello?").matched, false);
  assert.equal(detectScreener("Hi this is Ada speaking").matched, false);
  assert.equal(detectScreener("").matched, false);
});
