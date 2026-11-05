import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCREENER_SCRIPT, SCRIPT_TEMPLATES, rebuttalLines, renderScript } from "./scripts";

const KNOWN = ["first_name", "last_name", "agent", "company", "city", "state"];

test("templates have unique keys and only known variables", () => {
  const keys = new Set(SCRIPT_TEMPLATES.map((t) => t.key));
  assert.equal(keys.size, SCRIPT_TEMPLATES.length);
  for (const t of SCRIPT_TEMPLATES) {
    const text = t.body + rebuttalLines(t);
    for (const m of text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) assert.ok(KNOWN.includes(m[1]!), `${t.key}: unknown variable ${m[1]}`);
  }
});

test("solar exit fronter is first, names the company and honours stop calling", () => {
  const t = SCRIPT_TEMPLATES[0]!;
  assert.equal(t.key, "solar-exit-fronter");
  assert.match(t.body, /\{\{company\}\}/);
  assert.match(t.body, /recorded/i);
  assert.match(t.body, /do-not-call/i);
  assert.match(t.body, /VOICEMAIL/);
  assert.doesNotMatch(t.body, /\b(I|we|we'll|I'll) (can |will )?(guarantee|promise)\b/i, "the fronter never promises an outcome");
  const lines = rebuttalLines(t).split("\n");
  assert.ok(lines.length >= 4);
  for (const l of lines) assert.match(l, /^[^|]+ \| .+$/);
});

const vars = { agentName: "Dana", company: "National Solar Resolutions", lead: { firstName: "Pat", lastName: "Lee", city: "Tampa", state: "FL" } };

test("the default screener script reads with the agent, company and lead filled in", () => {
  assert.equal(renderScript(DEFAULT_SCREENER_SCRIPT, vars), "Hi, this is Dana with National Solar Resolutions returning a call about Pat's solar account. Please pick up.");
});

test("snake case and dotted variables are the same thing", () => {
  assert.equal(renderScript("{{first_name}} {{lead.firstName}} {{agent}} {{agent.firstName}} {{ company }}", vars), "Pat Pat Dana Dana National Solar Resolutions");
});

test("a missing lead falls back to neutral words and unknown keys stay visible", () => {
  assert.equal(renderScript("Hi {{first_name}} in {{city}} {{nope}}", { ...vars, lead: null }), "Hi there in your area {{nope}}");
});
