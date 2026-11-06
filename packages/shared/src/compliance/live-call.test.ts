import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BANNED_PHRASES, DEFAULT_DISCLOSURE_PHRASES, LIVE_CALL_RULES, bannedPhraseAlert, disclosureAlert, disclosureHeard, disclosureState, findBannedPhrases, hasPhrase, parsePhraseList } from "./live-call";

test("defaults are the owner's lists", () => {
  for (const p of ["recorded", "recording", "quality and training"]) assert.ok(DEFAULT_DISCLOSURE_PHRASES.includes(p));
  assert.deepEqual([...DEFAULT_BANNED_PHRASES], ["guaranteed", "free", "no cost", "risk-free"]);
  assert.equal(LIVE_CALL_RULES.disclosure_missing.agentMessage, "Give the recording disclosure now");
});

test("disclosure is heard as whole words", () => {
  assert.equal(disclosureHeard("Just so you know this call is recorded."), "recorded");
  assert.equal(disclosureHeard("calls are monitored for Quality and Training purposes"), "quality and training");
  assert.equal(disclosureHeard("I'm recording this", ["recorded"]), null);
  assert.equal(disclosureHeard("hello how are you"), null);
});

test("banned phrases, with ordinary speech excepted", () => {
  const banned = [...DEFAULT_BANNED_PHRASES];
  assert.deepEqual(findBannedPhrases("It's guaranteed to cut your bill", banned), ["guaranteed"]);
  assert.deepEqual(findBannedPhrases("the review is free and there's no cost to you", banned), ["free", "no cost"]);
  assert.deepEqual(findBannedPhrases("it's completely risk-free", banned), ["risk-free"]);
  assert.deepEqual(findBannedPhrases("feel free to call our toll-free number", banned), []);
  assert.deepEqual(findBannedPhrases("are you free on Tuesday?", banned), []);
  assert.deepEqual(findBannedPhrases("freedom from bills", banned), []);
  assert.deepEqual(findBannedPhrases("anything", []), []);
});

test("phrase lists parse from lines or commas", () => {
  assert.deepEqual(parsePhraseList("Guaranteed\nfree,  no   cost\n\nfree"), ["guaranteed", "free", "no cost"]);
  assert.deepEqual(parsePhraseList(["A", "a", " b "]), ["a", "b"]);
  assert.deepEqual(parsePhraseList(null), []);
  assert.equal(parsePhraseList(Array.from({ length: 80 }, (_, i) => `p${i}`)).length, 50);
  assert.equal(hasPhrase("x", ""), false);
});

test("disclosure state: 30 s from the join, never an alert when it cannot be heard", () => {
  const base = { required: true, playedByFile: false, agentTranscribed: true, bridgedAt: 0, heardAt: null, now: 10_000 };
  assert.equal(disclosureState(base), "pending");
  assert.equal(disclosureState({ ...base, now: 30_000 }), "overdue");
  assert.equal(disclosureState({ ...base, now: 40_000, heardAt: 35_000 }), "given");
  assert.equal(disclosureState({ ...base, required: false, now: 99_000 }), "not_required");
  assert.equal(disclosureState({ ...base, playedByFile: true, now: 99_000 }), "not_required");
  assert.equal(disclosureState({ ...base, agentTranscribed: false, now: 99_000 }), "unknown");
  assert.equal(disclosureState({ ...base, bridgedAt: null, now: 99_000 }), "unknown");
  assert.equal(disclosureState({ ...base, now: 15_000, windowSeconds: 10 }), "overdue");
});

test("alerts carry the rule and the words", () => {
  const a = bannedPhraseAlert("free", "it's free", 5);
  assert.equal(a.rule, "banned_phrase");
  assert.match(a.message, /"free"/);
  assert.equal(disclosureAlert(7).message, "Give the recording disclosure now");
});
