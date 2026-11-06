import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTED_STEPS, TIMELINE_TEXT, addBusinessDays, callingNotes, onboardingProgress, readOnboarding, recommendedPrepayment, requiredMissing, stepStatus, timeline, type OnboardingState, type StepContext } from "./onboarding";
import type { WebsiteFindings } from "./tendlc";

const ctx: StepContext = { funded: false, leadCount: 0, invitedCount: 0, registrationStatus: null };
const empty = (): OnboardingState => readOnboarding(null);
const site: WebsiteFindings = { url: "https://acmeroofing.com", checkedAt: "", reachable: true, https: true, showsName: true, privacyUrl: "https://acmeroofing.com/privacy", termsUrl: "https://acmeroofing.com/terms", privacyReachable: true, privacyNoSharing: true, smsDisclosure: true };
const business = { entityType: "PRIVATE_PROFIT", legalName: "Acme Roofing LLC", ein: "13-4567890", vertical: "CONSTRUCTION", website: "https://acmeroofing.com", phone: "3059991234", supportEmail: "hi@acmeroofing.com", street: "1 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" };

test("readOnboarding copes with null and junk", () => {
  assert.deepEqual(readOnboarding(null), { steps: {}, meta: {} });
  assert.deepEqual(readOnboarding([1, 2]), { steps: {}, meta: {} });
  assert.equal(readOnboarding({ steps: { you: { name: "A" } }, finishedAt: "x" }).steps.you?.name, "A");
});

test("only contact name and email are required", () => {
  assert.deepEqual(requiredMissing(empty()), ["contact name", "email"]);
  const s = { ...empty(), steps: { you: { name: "Ann Lee", email: "ann@acmeroofing.com" } } };
  assert.deepEqual(requiredMissing(s), []);
  assert.deepEqual(requiredMissing({ ...s, steps: { you: { name: " ", email: "ann@" } } }), ["contact name", "email"]);
  assert.equal(stepStatus("you", empty(), ctx), "needs");
  assert.equal(stepStatus("you", s, ctx), "done");
});

test("untouched optional steps are to-do, typed in but incomplete needs info, skipped stays skipped", () => {
  const s = empty();
  for (const k of COUNTED_STEPS.filter((k) => k !== "you")) assert.equal(stepStatus(k, s, ctx), "todo", k);
  s.meta.business = { updatedAt: "2026-11-06T00:00:00Z" };
  s.steps.business = { legalName: "Acme Roofing LLC" };
  assert.equal(stepStatus("business", s, ctx), "needs");
  s.meta.team = { skippedAt: "2026-11-06T00:00:00Z" };
  assert.equal(stepStatus("team", s, ctx), "skipped");
  assert.equal(stepStatus("team", s, { ...ctx, invitedCount: 2 }), "done");
});

test("business is done only with no 10DLC errors and a clean website check", () => {
  const s = { ...empty(), steps: { business }, meta: { business: { updatedAt: "x" } } };
  assert.equal(stepStatus("business", s, ctx), "needs", "website not checked yet");
  assert.equal(stepStatus("business", { ...s, website: site }, ctx), "done");
  assert.equal(stepStatus("business", { ...s, website: { ...site, privacyUrl: null } }, ctx), "needs");
  assert.equal(stepStatus("business", { ...s, steps: { business: { ...business, ein: "1" } }, website: site }, ctx), "needs");
});

test("texting, calling, leads, payment", () => {
  const s = empty();
  assert.equal(stepStatus("texting", { ...s, registration: { campaignSubmittedAt: "x" } }, ctx), "done");
  assert.equal(stepStatus("texting", s, { ...ctx, registrationStatus: "MNO_PROVISIONED" }), "done");
  assert.equal(stepStatus("calling", { ...s, steps: { calling: { about: "Roof quotes", states: ["FL"], hoursStart: 9, hoursEnd: 20 } } }, ctx), "done");
  assert.equal(stepStatus("calling", { ...s, steps: { calling: { about: "Roof quotes", states: ["FL"], hoursStart: 20, hoursEnd: 9 } }, meta: { calling: { updatedAt: "x" } } }, ctx), "needs");
  assert.equal(stepStatus("leads", { ...s, steps: { leads: { hasFile: "no" } } }, ctx), "skipped");
  assert.equal(stepStatus("leads", s, { ...ctx, leadCount: 10 }), "done");
  assert.equal(stepStatus("payment", s, { ...ctx, funded: true }), "done");
  assert.equal(stepStatus("payment", { ...s, paymentRequest: { amountCents: 50000, requestedAt: "x", provider: "none" } }, ctx), "done");
});

test("progress counts seven steps; Finish completes it", () => {
  const p = onboardingProgress(empty(), ctx);
  assert.equal(p.total, 7);
  assert.equal(p.done, 0);
  assert.equal(p.complete, false);
  const s = { ...empty(), steps: { you: { name: "Ann", email: "ann@acmeroofing.com" } } };
  const q = onboardingProgress(s, { ...ctx, funded: true, leadCount: 5 });
  assert.equal(q.done, 3);
  assert.equal(q.pct, 43);
  assert.equal(onboardingProgress({ ...s, finishedAt: "x" }, ctx).complete, true);
});

test("the 7-day timeline text and dates", () => {
  assert.equal(TIMELINE_TEXT, "Most clients are fully live in about 7 days: texting registration (10DLC) usually takes about 3 business days; numbers and dialing are ready the same day once you add funds.");
  // Friday 6 Nov 2026 + 3 business days = Wednesday 11 Nov.
  assert.equal(addBusinessDays(new Date("2026-11-06T15:00:00Z"), 3).toISOString().slice(0, 10), "2026-11-11");
  const t = timeline(new Date("2026-11-06T15:00:00Z"), new Date("2026-11-06T15:00:00Z"));
  assert.equal(t.liveBy.toISOString().slice(0, 10), "2026-11-13");
  assert.equal(t.lines[0], TIMELINE_TEXT);
  assert.match(t.lines[1]!, /Fri, Nov 6.*about Fri, Nov 13/);
  assert.match(t.lines[2]!, /usually answer by Wed, Nov 11/);
  assert.equal(timeline(new Date("2026-11-06T15:00:00Z"), null).textingBy, null);
});

test("recommended prepayment: seats × plan + minutes + numbers, up to the next $100", () => {
  const r = recommendedPrepayment({ seats: 5, seatMonthlyCents: 7000, perMinuteMillicents: 1200, numbers: 10, numberMonthlyCents: 165 });
  assert.equal(r.minutes, 5 * 180 * 21);
  assert.deepEqual(
    r.lines.map((l) => l.cents),
    [35000, 22680, 1650],
  );
  assert.equal(r.totalCents, 59330);
  assert.equal(r.recommendedCents, 60000);
  assert.equal(recommendedPrepayment({ seats: 0, seatMonthlyCents: 7000, perMinuteMillicents: 1200, numbers: 0, numberMonthlyCents: 165 }).recommendedCents, 10000, "never below $100");
  assert.equal(recommendedPrepayment({ seats: 1, seatMonthlyCents: 7000, perMinuteMillicents: 1200, numbers: 1, numberMonthlyCents: 165, minutesPerSeatPerDay: 0 }).recommendedCents, 10000);
});

test("calling hours are checked against each state's rule", () => {
  const n = callingNotes(8, 21, ["fl", "TX", "OH", "FL"]);
  assert.deepEqual(
    n.map((x) => x.state),
    ["FL", "OH", "TX"],
  );
  const fl = n.find((x) => x.state === "FL")!;
  assert.equal(fl.end, 20);
  assert.equal(fl.clipped, true);
  assert.ok(fl.lines.some((l) => /At most 3 calls/.test(l)));
  const tx = n.find((x) => x.state === "TX")!;
  assert.equal(tx.start, 9);
  assert.ok(tx.lines.some((l) => /Sunday: noon to 9pm only/.test(l)));
  const oh = n.find((x) => x.state === "OH")!;
  assert.equal(oh.hasRule, false);
  assert.equal(oh.clipped, false);
  assert.equal(callingNotes(10, 18, ["FL"])[0]!.clipped, false);
});
