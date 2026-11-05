import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WHISPER, chooseTransferCallerId, destinationE164, renderWhisper, unansweredOutcome, whisperVars, WHISPER_VARIABLES } from "./transfers";

const ctx = { company: "Crossbar", campaign: "Solar Exit", destination: "Closers desk", agent: "Ada", lead: { firstName: "Grace", lastName: "Hopper", phone: "3055550100", city: "Miami", state: "FL" } };

test("the default whisper names the company, campaign and lead", () => {
  assert.equal(renderWhisper(null, ctx), "Transfer from Crossbar, Solar Exit. Lead Grace Hopper.");
  assert.equal(renderWhisper("", ctx), renderWhisper(DEFAULT_WHISPER, ctx));
});

test("whisper templates accept the script variables and dotted lead keys; empty names leave no gaps", () => {
  assert.equal(renderWhisper("{{first_name}} {{last_name}} for {{destination}} from {{agent}}", ctx), "Grace Hopper for Closers desk from Ada");
  assert.equal(renderWhisper("Lead {{lead.firstName}} {{lead.lastName}}.", { ...ctx, lead: { firstName: "Grace" } }), "Lead Grace.");
  assert.equal(renderWhisper("Lead {{lead.firstName}} {{lead.lastName}}.", { ...ctx, lead: null }), "Lead.");
  for (const v of WHISPER_VARIABLES) assert.ok(v in whisperVars(ctx), v);
});

test("caller ID: the customer's number first, a static number only when it is ours, else the campaign's", () => {
  const base = { leadPhone: "3055550100", staticCallerId: "7865550199", ownedNumbers: ["+17865550199"], campaignCallerId: "3055550123" };
  assert.deepEqual(chooseTransferCallerId({ mode: "CUSTOMER", ...base }), { phone: "3055550100", source: "customer" });
  assert.deepEqual(chooseTransferCallerId({ mode: "STATIC", ...base }), { phone: "7865550199", source: "static" });
  assert.deepEqual(chooseTransferCallerId({ mode: "STATIC", ...base, ownedNumbers: [] }), { phone: "3055550123", source: "fallback" });
  assert.deepEqual(chooseTransferCallerId({ mode: "CUSTOMER", ...base, leadPhone: null }), { phone: "3055550123", source: "fallback" });
  assert.equal(chooseTransferCallerId({ mode: "CUSTOMER", leadPhone: null, staticCallerId: null, ownedNumbers: [], campaignCallerId: null }), null);
});

test("unanswered outcomes and destination numbers", () => {
  assert.equal(unansweredOutcome("no-answer", false), "NO_ANSWER");
  assert.equal(unansweredOutcome("busy", false), "NO_ANSWER");
  assert.equal(unansweredOutcome("failed", false), "FAILED");
  assert.equal(unansweredOutcome("failed", true), "CANCELLED");
  assert.equal(destinationE164("(305) 555-0100"), "+13055550100");
  assert.equal(destinationE164("+13055550100"), "+13055550100");
  assert.equal(destinationE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(destinationE164("555"), null);
});
