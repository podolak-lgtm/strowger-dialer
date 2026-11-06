import assert from "node:assert/strict";
import { test } from "node:test";
import { coverSteps, scriptSteps, wordsNeeded } from "./script";
import { SCRIPT_TEMPLATES } from "../scripts";

const SCRIPT = `OPENER
Hi {{first_name}}, this is {{agent}} with {{company}}. How are you today?

DISCLOSURE:
This call may be recorded for quality and training purposes.

1. Do you own your home?
2. What is your average monthly electric bill?
3. Are you currently paying a solar loan?

Thanks for that. I'll connect you with a specialist who can review your options.`;

test("headings, numbered lines and paragraphs become steps", () => {
  const steps = scriptSteps(SCRIPT);
  assert.deepEqual(
    steps.map((s) => s.title),
    ["OPENER", "DISCLOSURE", "Do you own your home?", "What is your average monthly electric bill?", "Are you currently paying a solar loan?", "Thanks for that. I'll connect you with a…"],
  );
  assert.ok(steps[1]!.keywords.includes("record"));
  assert.ok(!steps[0]!.text.includes("{{"));
});

test("a numbered line right under a heading joins that heading's step; == HEADINGS == count", () => {
  const steps = scriptSteps("QUESTIONS\n1. Do you own your home?\n2. What is your monthly bill?\n\n== CLOSE (use if qualified) ==\nLet me bring in my specialist.");
  assert.deepEqual(steps.map((s) => s.title), ["QUESTIONS", "What is your monthly bill?", "CLOSE (use if qualified)"]);
  assert.ok(steps[0]!.keywords.includes("own"));
});

test("blank-line paragraphs without headings", () => {
  const steps = scriptSteps("Hello, thanks for taking my call.\n\nI'm calling about your energy bill.\n\nCan I ask two quick questions?");
  assert.equal(steps.length, 3);
  assert.equal(steps[1]!.title, "I'm calling about your energy bill.");
});

test("empty scripts and lines with nothing to listen for", () => {
  assert.deepEqual(scriptSteps(""), []);
  assert.deepEqual(scriptSteps(null), []);
  assert.deepEqual(scriptSteps("{{first_name}}\n\n..."), []);
});

test("coverage needs half the key words of a step", () => {
  const steps = scriptSteps(SCRIPT);
  const p0 = coverSteps(steps, []);
  assert.deepEqual(p0.covered, []);
  assert.equal(p0.next, 0);
  const p1 = coverSteps(steps, ["hi John, this is Maria with National Solar, how are you today", "just so you know this call is recorded for quality and training"]);
  assert.ok(p1.covered.includes(0));
  assert.ok(p1.covered.includes(1));
  assert.equal(p1.next, 2);
  const all = coverSteps(steps, [SCRIPT.replace(/\{\{[^}]+\}\}/g, "x")]);
  assert.equal(all.next, null);
});

test("steps can be covered out of order; next is the first uncovered", () => {
  const steps = scriptSteps(SCRIPT);
  const p = coverSteps(steps, ["are you currently paying a solar loan on those panels"]);
  const loan = steps.findIndex((s) => s.title.startsWith("Are you currently"));
  assert.ok(p.covered.includes(loan));
  assert.equal(p.next, 0);
});

test("words needed", () => {
  assert.equal(wordsNeeded({ keywords: ["a"] }), 1);
  assert.equal(wordsNeeded({ keywords: ["a", "b"] }), 2);
  assert.equal(wordsNeeded({ keywords: ["a", "b", "c", "d", "e"] }), 3);
});

test("every bundled script template splits into steps", () => {
  for (const t of SCRIPT_TEMPLATES) assert.ok(scriptSteps(t.body).length >= 3, t.key);
});
