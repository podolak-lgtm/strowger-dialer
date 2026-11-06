import assert from "node:assert/strict";
import { test } from "node:test";
import { answerableWaitSeconds, forcedHoldUntil, holdConflict, inForcedHold, oldestAnswerableWait } from "./hold";
import { summarizeInbound, type InboundFact } from "./metrics";

const T = 1_800_000_000_000;

test("forced hold: until arrival + minHold; off at 0; VIP bypass; callbacks and AI hand-offs exempt", () => {
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: 120, vip: false, bypassVip: true }), T + 120_000);
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: 0, vip: false, bypassVip: true }), null);
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: 120, vip: true, bypassVip: true }), null);
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: 120, vip: true, bypassVip: false }), T + 120_000);
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: 120, vip: false, bypassVip: true, exempt: true }), null);
  assert.equal(forcedHoldUntil({ queuedAt: T, minHoldSeconds: -5, vip: false, bypassVip: true }), null);
});

test("in hold until the moment it ends, then answerable", () => {
  assert.equal(inForcedHold(T + 60_000, T + 59_999), true);
  assert.equal(inForcedHold(T + 60_000, T + 60_000), false);
  assert.equal(inForcedHold(null, T), false);
});

test("blending counts from the end of the forced hold", () => {
  // Arrived at T with a 60 s hold: nothing to count at 50 s, 30 s at 90 s.
  assert.equal(answerableWaitSeconds(T, T + 60_000, T + 50_000), null);
  assert.equal(answerableWaitSeconds(T, T + 60_000, T + 90_000), 30);
  assert.equal(answerableWaitSeconds(T, null, T + 90_000), 90);
  const callers = [
    { arrivalMs: T, holdUntil: T + 120_000 }, // still held at T+100 s
    { arrivalMs: T + 10_000, holdUntil: null }, // VIP: 90 s answerable
  ];
  assert.equal(oldestAnswerableWait(callers, T + 100_000), 90);
  assert.equal(oldestAnswerableWait([{ arrivalMs: T, holdUntil: T + 120_000 }], T + 100_000), null);
});

test("overflow must not beat the hold", () => {
  assert.match(holdConflict({ minHoldSeconds: 120, maxWaitSeconds: 60 }) ?? "", /at least the forced hold/);
  assert.equal(holdConflict({ minHoldSeconds: 120, maxWaitSeconds: 120 }), null);
  assert.equal(holdConflict({ minHoldSeconds: 0, maxWaitSeconds: 15 }), null);
});

const fact = (over: Partial<InboundFact>): InboundFact => ({ phone: "5125550100", queuedAt: T, bridgedAt: null, talkEndedAt: null, wrapEndedAt: null, abandonedInQueue: false, waitSeconds: null, surveyScore: null, ...over });

test("metrics: forced-hold abandons counted apart, SLA measured after the hold, total wait still shown", () => {
  const calls: InboundFact[] = [
    // 120 s hold, answered 10 s after it: within a 20 s SLA, total wait 130.
    fact({ phone: "1", bridgedAt: T + 130_000, waitSeconds: 130, forcedHoldSeconds: 120 }),
    // 120 s hold, answered 50 s after: misses the SLA.
    fact({ phone: "2", bridgedAt: T + 170_000, waitSeconds: 170, forcedHoldSeconds: 120 }),
    // Hung up 40 s into the hold.
    fact({ phone: "3", abandonedInQueue: true, abandonedInForcedHold: true, waitSeconds: 40, forcedHoldSeconds: 120 }),
    // Hung up after the hold.
    fact({ phone: "4", abandonedInQueue: true, waitSeconds: 150, forcedHoldSeconds: 120 }),
    // VIP, no hold, answered in 5 s.
    fact({ phone: "5", bridgedAt: T + 5_000, waitSeconds: 5 }),
  ];
  const s = summarizeInbound(calls, { slaSeconds: 20 });
  assert.equal(s.offered, 5);
  assert.equal(s.abandoned, 2);
  assert.equal(s.abandonedInForcedHold, 1);
  assert.equal(s.slaOffered, 4);
  assert.equal(s.answeredWithinSla, 2); // calls 1 and 5
  assert.equal(s.serviceLevelPct, 50); // 2 of 4
  assert.equal(s.asaSeconds, 102); // (130 + 170 + 5) / 3
  assert.equal(s.asaAfterHoldSeconds, 22); // (10 + 50 + 5) / 3
  assert.equal(s.abandonRatePct, 25); // 1 after the hold of 4
  assert.equal(s.forcedHoldDropPct, 20); // 1 of 5
  assert.equal(s.longestWaitSeconds, 170);
});

test("metrics: without a hold nothing changes", () => {
  const s = summarizeInbound([fact({ bridgedAt: T + 15_000, waitSeconds: 15 }), fact({ abandonedInQueue: true, waitSeconds: 30 })], { slaSeconds: 20 });
  assert.equal(s.slaOffered, 2);
  assert.equal(s.serviceLevelPct, 50);
  assert.equal(s.abandonRatePct, 50);
  assert.equal(s.asaAfterHoldSeconds, s.asaSeconds);
  assert.equal(s.forcedHoldDropPct, 0);
});
