import assert from "node:assert/strict";
import { test } from "node:test";
import { contentStems, matchRebuttal, objectionScore, stem } from "./match";

const LIB = [
  { objection: "Not interested", response: "I understand. Most people say that before they hear the numbers. Can I ask one quick question?" },
  { objection: "I already have solar", response: "Great, then this is about the panels you have: are you still paying the loan?" },
  { objection: "How did you get my number?", response: "You asked about solar options online; I can take you off the list if you like." },
  { objection: "Too expensive", response: "That's exactly why we call: the review costs nothing to look at." },
  { objection: "Send me something in writing", response: "Happy to. What email is best?" },
];

test("stems meet across endings", () => {
  assert.equal(stem("calling"), stem("calls"));
  assert.equal(stem("called"), "call");
  assert.equal(stem("companies"), "company");
  assert.deepEqual(contentStems("I'm not interested"), ["not", "interest"]);
});

test("the exact objection inside a longer sentence is a full match", () => {
  const m = matchRebuttal("Look, honestly I'm not interested, thanks", LIB);
  assert.ok(m);
  assert.equal(m.index, 0);
  assert.equal(m.score, 1);
});

test("paraphrases with most of the words match", () => {
  const m = matchRebuttal("we already have solar panels on the house", LIB);
  assert.equal(m?.index, 1);
  const n = matchRebuttal("where did you even get my number from", LIB);
  assert.equal(n?.index, 2);
  const w = matchRebuttal("can you just send me something in writing", LIB);
  assert.equal(w?.index, 4);
});

test("unrelated speech and fillers do not match", () => {
  assert.equal(matchRebuttal("what's the weather like over there", LIB), null);
  assert.equal(matchRebuttal("yeah okay", LIB), null);
  assert.equal(matchRebuttal("", LIB), null);
  // Shares only "not" with "Not interested": below the threshold.
  assert.equal(matchRebuttal("I'm not sure what this is about", LIB), null);
});

test("the best of several candidates wins and empty rows are skipped", () => {
  const lib = [{ objection: "", response: "x" }, { objection: "price", response: "Let's look at the price." }, ...LIB];
  const m = matchRebuttal("it is just too expensive for us", lib);
  assert.equal(m?.objection, "Too expensive");
  assert.equal(matchRebuttal("what's the price on this", lib)?.objection, "price");
});

test("score is between 0 and 1", () => {
  for (const r of LIB) {
    const s = objectionScore("not interested in solar, too expensive, how did you get my number", r.objection);
    assert.ok(s >= 0 && s <= 1);
  }
});
