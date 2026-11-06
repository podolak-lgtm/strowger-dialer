import assert from "node:assert/strict";
import { test } from "node:test";
import { occupancy, stateDurations, summarizeInbound, type InboundFact } from "./metrics";

const T = 1_800_000_000_000;
const call = (over: Partial<InboundFact>): InboundFact => ({ phone: "5125550100", queuedAt: T, bridgedAt: null, talkEndedAt: null, wrapEndedAt: null, abandonedInQueue: false, waitSeconds: null, surveyScore: null, ...over });

const calls: InboundFact[] = [
  // Answered in 10 s, 120 s talk, 30 s wrap, rated 5.
  call({ phone: "1111111111", bridgedAt: T + 10_000, talkEndedAt: T + 130_000, wrapEndedAt: T + 160_000, waitSeconds: 10, surveyScore: 5 }),
  // Answered in 40 s (misses a 20 s SLA), 60 s talk, no wrap recorded, rated 3.
  call({ phone: "2222222222", bridgedAt: T + 40_000, talkEndedAt: T + 100_000, waitSeconds: 40, surveyScore: 3 }),
  // Hung up after 25 s in the queue.
  call({ phone: "3333333333", abandonedInQueue: true, waitSeconds: 25 }),
  // Overflowed to voicemail after 300 s.
  call({ phone: "4444444444", waitSeconds: 300 }),
];

test("service level, ASA, abandon rate and AHT", () => {
  const s = summarizeInbound(calls, { slaSeconds: 20 });
  assert.equal(s.offered, 4);
  assert.equal(s.answered, 2);
  assert.equal(s.abandoned, 1);
  assert.equal(s.overflowed, 1);
  assert.equal(s.answeredWithinSla, 1);
  assert.equal(s.serviceLevelPct, 25);
  assert.equal(s.asaSeconds, 25);
  assert.equal(s.abandonRatePct, 25);
  assert.equal(s.ahtSeconds, 105); // (150 + 60) / 2
  assert.equal(s.talkSeconds, 180);
  assert.equal(s.wrapSeconds, 30);
  assert.equal(s.longestWaitSeconds, 300);
  assert.equal(s.surveys, 2);
  assert.equal(s.surveyAvg, 4);
});

test("the wait falls back to bridge minus entry when not stored", () => {
  const s = summarizeInbound([call({ bridgedAt: T + 15_000 })], { slaSeconds: 20 });
  assert.equal(s.asaSeconds, 15);
  assert.equal(s.serviceLevelPct, 100);
});

test("first-call resolution: no repeat inbound call from the number within 7 days", () => {
  const later = [
    { phone: "1111111111", at: T + 3 * 86_400_000 }, // repeat inside the window: not resolved
    { phone: "2222222222", at: T + 8 * 86_400_000 }, // outside the window: resolved
    { phone: "2222222222", at: T }, // the call itself never counts
  ];
  assert.equal(summarizeInbound(calls, { slaSeconds: 20, laterInbound: later }).fcrPct, 50);
  assert.equal(summarizeInbound(calls, { slaSeconds: 20 }).fcrPct, 100);
});

test("nothing offered: zeros, not NaN", () => {
  const s = summarizeInbound([], { slaSeconds: 20 });
  assert.equal(s.serviceLevelPct, 0);
  assert.equal(s.asaSeconds, 0);
  assert.equal(s.longestWaitSeconds, 0);
  assert.equal(s.surveyAvg, null);
});

test("state durations clip to the window and occupancy counts calls and wrap over ready", () => {
  const d = stateDurations(
    [
      { state: "READY", at: T + 60_000 },
      { state: "ON_CALL", at: T + 120_000 },
      { state: "WRAP_UP", at: T + 300_000 },
      { state: "READY", at: T + 330_000 },
    ],
    { state: "PAUSED", at: T },
    T,
    T + 360_000,
  );
  assert.deepEqual(d, { PAUSED: 60, READY: 90, ON_CALL: 180, WRAP_UP: 30 });
  assert.deepEqual(occupancy(d), { occupancyPct: 70, idleSeconds: 90, busySeconds: 210 });
  assert.deepEqual(stateDurations([], { state: "READY", at: T - 60_000 }, T, T + 30_000), { READY: 30 });
});
