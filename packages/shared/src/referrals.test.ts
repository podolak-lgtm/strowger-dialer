import assert from "node:assert/strict";
import { test } from "node:test";
import {
  businessKey,
  checkTrialEligible,
  clawbackCents,
  commissionBase,
  commissionCents,
  computeReferralMonth,
  inTrial,
  isReferralCode,
  isSelfReferral,
  monthEligibility,
  monthRange,
  normalizeReferralCode,
  previousPeriod,
  referralCodeFrom,
  referralNote,
  referralPct,
  referrerLapsed,
  trialDay,
  trialLeftoverCents,
  trialOverAt,
  trialReminderDue,
  type ReferredMonth,
  type ReferrerMonth,
} from "./referrals";

const activeReferrer: ReferrerMonth = { suspendedAtEnd: false, closed: false, paymentsCents: 50000, balanceAtEndCents: 12000, seatCharges: 3 };
const activeReferred: ReferredMonth = { suspendedAtEnd: false, closed: false, inTrialAtEnd: false, chargesCents: 100000, paymentsCents: 150000, refundsCents: 0, openingFundedCents: 0 };
const month = (over: Partial<Parameters<typeof computeReferralMonth>[0]> = {}) => computeReferralMonth({ pct: 5, endedBeforeMonthEnd: false, referrer: activeReferrer, referred: activeReferred, priorBaseCents: 0, priorClawedBaseCents: 0, ...over });

test("the owner's example: a $1,000 bill at 5% is a $50 credit", () => {
  assert.equal(commissionCents(100000, 5), 5000);
  const r = month();
  assert.equal(r.status, "CREDIT");
  assert.equal(r.baseCents, 100000);
  assert.equal(r.creditCents, 5000);
  assert.equal(referralNote({ referredName: "Acme", period: "2026-11", pct: 5, baseCents: r.baseCents }), "Referral credit: Acme, 2026-11, 5% of $1,000.00");
});

test("commission rounds to the cent and is never negative", () => {
  assert.equal(commissionCents(33333, 5), 1667);
  assert.equal(commissionCents(0, 5), 0);
  assert.equal(commissionCents(-100, 5), 0);
  assert.equal(commissionCents(100000, 7.5), 7500);
});

test("base is the charges covered by real money", () => {
  // Billed $1,000, paid $600 this month with $100 carried in: only $700 was covered.
  assert.equal(commissionBase({ chargesCents: 100000, paymentsCents: 60000, refundsCents: 0, openingFundedCents: 10000 }), 70000);
  // Paid more than they used: the base is what they used.
  assert.equal(commissionBase({ chargesCents: 40000, paymentsCents: 100000, refundsCents: 0, openingFundedCents: 0 }), 40000);
  // Refunds come off the month's payments first.
  assert.equal(commissionBase({ chargesCents: 100000, paymentsCents: 100000, refundsCents: 30000, openingFundedCents: 0 }), 70000);
  // A negative carried-in balance does not reduce the month's money below its payments.
  assert.equal(commissionBase({ chargesCents: 50000, paymentsCents: 50000, refundsCents: 0, openingFundedCents: -20000 }), 50000);
  assert.equal(commissionBase({ chargesCents: 0, paymentsCents: 50000, refundsCents: 0, openingFundedCents: 0 }), 0);
});

test("an inactive referrer forfeits the month: zero line with the reason, nothing banked", () => {
  const noSeat = month({ referrer: { ...activeReferrer, seatCharges: 0 } });
  assert.equal(noSeat.status, "FORFEITED");
  assert.equal(noSeat.creditCents, 0);
  assert.equal(noSeat.baseCents, 100000);
  assert.match(noSeat.reason ?? "", /no active seat/);
  const suspended = month({ referrer: { ...activeReferrer, suspendedAtEnd: true } });
  assert.equal(suspended.status, "FORFEITED");
  assert.match(suspended.reason ?? "", /suspended/);
  const unfunded = month({ referrer: { ...activeReferrer, paymentsCents: 0, balanceAtEndCents: 0 } });
  assert.equal(unfunded.status, "FORFEITED");
  // A positive balance with no payment that month still counts as a client.
  assert.equal(month({ referrer: { ...activeReferrer, paymentsCents: 0, balanceAtEndCents: 500 } }).status, "CREDIT");
  // Next month, active again: credited again (the forfeited month is not paid later).
  assert.equal(month().creditCents, 5000);
});

test("an inactive referred client means nothing to pay", () => {
  assert.equal(monthEligibility(activeReferrer, { ...activeReferred, chargesCents: 0 }).ok, false);
  assert.equal(monthEligibility(activeReferrer, { ...activeReferred, inTrialAtEnd: true }).ok, false);
  assert.equal(monthEligibility(activeReferrer, { ...activeReferred, suspendedAtEnd: true }).ok, false);
  assert.equal(monthEligibility(activeReferrer, { ...activeReferred, closed: true }).ok, false);
  assert.equal(monthEligibility(activeReferrer, activeReferred).ok, true);
});

test("an ended relationship earns nothing more", () => {
  const r = month({ endedBeforeMonthEnd: true });
  assert.equal(r.status, "FORFEITED");
  assert.equal(r.creditCents, 0);
});

test("refunds beyond the month's payments claw back earlier credit", () => {
  // Earlier months credited on $1,000 of base; this month they were refunded $400 and paid nothing.
  assert.deepEqual(clawbackCents({ paymentsCents: 0, refundsCents: 40000, priorBaseCents: 100000, priorClawedBaseCents: 0, pct: 5 }), { baseCents: 40000, amountCents: 2000 });
  // Never more than was credited and not yet clawed back.
  assert.deepEqual(clawbackCents({ paymentsCents: 0, refundsCents: 200000, priorBaseCents: 100000, priorClawedBaseCents: 80000, pct: 5 }), { baseCents: 20000, amountCents: 1000 });
  // A refund covered by the month's own payments is not a clawback (it lowered this month's base instead).
  assert.deepEqual(clawbackCents({ paymentsCents: 50000, refundsCents: 30000, priorBaseCents: 100000, priorClawedBaseCents: 0, pct: 5 }), { baseCents: 0, amountCents: 0 });
  // Clawback applies even when the month itself is forfeited.
  const r = month({ referrer: { ...activeReferrer, seatCharges: 0 }, referred: { ...activeReferred, paymentsCents: 0, refundsCents: 40000, chargesCents: 0 }, priorBaseCents: 100000 });
  assert.equal(r.status, "FORFEITED");
  assert.equal(r.clawbackCents, 2000);
});

test("a referrer lapses after 60 days with no payment or usage, or on closure", () => {
  const created = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(referrerLapsed({ lastActivityAt: new Date("2026-05-01T00:00:00Z"), createdAt: created, closedAt: null, now }).lapsed, false);
  assert.equal(referrerLapsed({ lastActivityAt: new Date("2026-04-01T00:00:00Z"), createdAt: created, closedAt: null, now }).lapsed, true);
  // A brand new workspace with no activity yet is not lapsed until 60 days after creation.
  assert.equal(referrerLapsed({ lastActivityAt: null, createdAt: new Date("2026-05-15T00:00:00Z"), closedAt: null, now }).lapsed, false);
  assert.equal(referrerLapsed({ lastActivityAt: now, createdAt: created, closedAt: now, now }).lapsed, true);
});

test("per-referrer override replaces the platform rate", () => {
  assert.equal(referralPct(5, null), 5);
  assert.equal(referralPct(5, 7.5), 7.5);
  assert.equal(referralPct(5, 0), 0);
});

test("one trial per business: domain, or the whole address for free mail", () => {
  assert.equal(businessKey("Jane@Acme.com"), "acme.com");
  assert.equal(businessKey("j.a.n.e+trial@gmail.com"), "jane@gmail.com");
  assert.equal(businessKey("bob@yahoo.co.uk"), "bob@yahoo.co.uk");
  assert.equal(businessKey("bob@outlook.com"), "bob@outlook.com");
  const taken = { takenKeys: ["acme.com", "jane@gmail.com"], takenPhones: ["5612718275"] };
  assert.equal(checkTrialEligible({ email: "sam@acme.com", phone: "305-555-1234", ...taken }).ok, false);
  assert.equal(checkTrialEligible({ email: "jane@gmail.com", phone: "305-555-1234", ...taken }).ok, false);
  // Another gmail user is a different business.
  assert.equal(checkTrialEligible({ email: "sam@gmail.com", phone: "305-555-1234", ...taken }).ok, true);
  assert.equal(checkTrialEligible({ email: "sam@newco.com", phone: "(561) 271-8275", ...taken }).ok, false);
  assert.equal(checkTrialEligible({ email: "sam@newco.com", phone: "", ...taken }).ok, false);
  const ok = checkTrialEligible({ email: "sam@newco.com", phone: "+1 305 555 1234", ...taken });
  assert.deepEqual(ok, { ok: true, key: "newco.com", phone: "3055551234" });
});

test("self-referral: same business domain or the same person", () => {
  assert.equal(isSelfReferral({ signupEmail: "new@acme.com", referrerEmails: ["boss@acme.com"], referrerClerkUserIds: [] }), true);
  assert.equal(isSelfReferral({ signupEmail: "me@gmail.com", referrerEmails: ["me@gmail.com"], referrerClerkUserIds: [] }), true);
  assert.equal(isSelfReferral({ signupEmail: "other@gmail.com", referrerEmails: ["me@gmail.com"], referrerClerkUserIds: [] }), false);
  assert.equal(isSelfReferral({ signupEmail: "x@newco.com", signupClerkUserId: "user_1", referrerEmails: ["boss@acme.com"], referrerClerkUserIds: ["user_1"] }), true);
});

test("trial state, day 5 reminder, and the leftover allowance", () => {
  const start = new Date("2026-11-01T12:00:00Z");
  const t = { trialStartedAt: start, trialEndsAt: new Date("2026-11-08T12:00:00Z"), trialConvertedAt: null, trialReminderAt: null };
  assert.equal(inTrial(t, new Date("2026-11-03T00:00:00Z")), true);
  assert.equal(inTrial(t, new Date("2026-11-08T12:00:00Z")), false);
  assert.equal(inTrial({ ...t, trialConvertedAt: new Date("2026-11-02T00:00:00Z") }, new Date("2026-11-03T00:00:00Z")), false);
  assert.equal(trialDay(t, start), 1);
  assert.equal(trialReminderDue(t, new Date("2026-11-04T12:00:00Z")), false);
  assert.equal(trialReminderDue(t, new Date("2026-11-05T12:00:00Z")), true);
  assert.equal(trialReminderDue({ ...t, trialReminderAt: new Date() }, new Date("2026-11-05T12:00:00Z")), false);
  assert.equal(trialOverAt({ ...t, trialConvertedAt: new Date("2026-11-03T00:00:00Z") })?.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(trialLeftoverCents({ allowanceCents: 5000, trialChargesCents: 1200, balanceCents: 3800 }), 3800);
  // Paid during the trial: only the unused allowance goes, never the payment.
  assert.equal(trialLeftoverCents({ allowanceCents: 5000, trialChargesCents: 1200, balanceCents: 103800 }), 3800);
  assert.equal(trialLeftoverCents({ allowanceCents: 5000, trialChargesCents: 9000, balanceCents: -4000 }), 0);
});

test("referral codes and months", () => {
  const code = referralCodeFrom([0, 1, 2, 3, 4, 5, 6, 200]);
  assert.equal(isReferralCode(code), true);
  assert.equal(normalizeReferralCode(` ${code.toLowerCase()} `), code);
  assert.equal(normalizeReferralCode("O0O0O0O0"), null);
  assert.equal(previousPeriod(new Date("2026-01-01T03:00:00Z")), "2025-12");
  const r = monthRange("2026-11");
  assert.equal(r.start.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(r.end.toISOString(), "2026-12-01T00:00:00.000Z");
});
