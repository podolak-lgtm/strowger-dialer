import assert from "node:assert/strict";
import { test } from "node:test";
import { announcementDue, announcementText, blendHolds, blendMessage, callerPriority, effectivePriority, estimateWaitSeconds, orderAgents, pickAcrossQueues, PRIORITY_DEFAULTS, queueScore, waitPhrase } from "./distribution";

const agents = [
  { userId: "c", idleSince: 3000, rating: 9, callsToday: 1 },
  { userId: "a", idleSince: 1000, rating: 4, callsToday: 5 },
  { userId: "b", idleSince: 2000, rating: 9, callsToday: 1 },
];
const ids = (xs: { userId: string }[]) => xs.map((x) => x.userId);

test("longest idle: whoever has been free the longest", () => {
  assert.deepEqual(ids(orderAgents("LONGEST_IDLE", agents)), ["a", "b", "c"]);
});

test("most skilled: rating first, longest idle breaks the tie", () => {
  assert.deepEqual(ids(orderAgents("MOST_SKILLED", agents)), ["b", "c", "a"]);
});

test("fewest calls: inbound calls today, then longest idle", () => {
  assert.deepEqual(ids(orderAgents("FEWEST_CALLS", agents)), ["b", "c", "a"]);
});

test("round robin rotates after the last agent served and wraps", () => {
  assert.deepEqual(ids(orderAgents("ROUND_ROBIN", agents)), ["a", "b", "c"]);
  assert.deepEqual(ids(orderAgents("ROUND_ROBIN", agents, "a")), ["b", "c", "a"]);
  assert.deepEqual(ids(orderAgents("ROUND_ROBIN", agents, "c")), ["a", "b", "c"]);
  // The pointer survives the last-served agent going off the floor.
  assert.deepEqual(ids(orderAgents("ROUND_ROBIN", agents.filter((x) => x.userId !== "b"), "b")), ["c", "a"]);
});

test("caller priority adds VIP and known-lead points to the queue's base", () => {
  const rule = { ...PRIORITY_DEFAULTS, priority: 5 };
  assert.equal(callerPriority(rule, { vip: false, knownLead: false }), 5);
  assert.equal(callerPriority(rule, { vip: false, knownLead: true }), 7);
  assert.equal(callerPriority(rule, { vip: true, knownLead: true }), 17);
});

test("without aging the score orders by priority, then arrival", () => {
  const t = 1_800_000_000_000;
  const early = queueScore(t, 0, 0);
  const late = queueScore(t + 3_600_000, 0, 0);
  const lateVip = queueScore(t + 3_600_000, 10, 0);
  assert.ok(early < late);
  assert.ok(lateVip < early, "a higher priority beats an hour's head start");
  assert.ok(queueScore(t, 1, 0) < queueScore(t - 86_400_000, 0, 0), "one point beats a day of waiting");
});

test("with aging a point is worth agingSeconds of waiting", () => {
  const t = 1_800_000_000_000;
  // Priority 2 arriving 90 s after a priority 0 caller, aging 60 s/point: virtual arrival 30 s earlier.
  assert.ok(queueScore(t + 90_000, 2, 60) < queueScore(t, 0, 60));
  // Arriving 150 s later is 30 s too late.
  assert.ok(queueScore(t + 150_000, 2, 60) > queueScore(t, 0, 60));
  // The score order matches effective priority at any later moment.
  const now = t + 400_000;
  const a = { p: 0, at: t };
  const b = { p: 2, at: t + 90_000 };
  assert.ok(effectivePriority(b.p, b.at, 60, now) > effectivePriority(a.p, a.at, 60, now));
  assert.equal(effectivePriority(3, t, 60, t + 120_000), 5);
  assert.equal(effectivePriority(3, t, 0, t + 120_000), 3);
});

test("an agent in several queues takes the highest effective priority, ties by arrival", () => {
  const now = 1_000_000;
  const heads = [
    { queueId: "sales", member: "c1", priority: 1, arrivalMs: now - 10_000, agingSeconds: 0 },
    { queueId: "vip", member: "c2", priority: 10, arrivalMs: now - 1_000, agingSeconds: 0 },
    { queueId: "support", member: "c3", priority: 0, arrivalMs: now - 900_000, agingSeconds: 60 }, // 15 points of aging
  ];
  assert.equal(pickAcrossQueues(heads, now)?.member, "c3");
  assert.equal(pickAcrossQueues(heads.slice(0, 2), now)?.member, "c2");
  const tie = [
    { queueId: "x", member: "late", priority: 2, arrivalMs: 500, agingSeconds: 0 },
    { queueId: "y", member: "early", priority: 2, arrivalMs: 100, agingSeconds: 0 },
  ];
  assert.equal(pickAcrossQueues(tie, now)?.member, "early");
  assert.equal(pickAcrossQueues([], now), null);
});

test("blending holds every qualified agent once the oldest caller waits too long", () => {
  const h = blendHolds([{ queueId: "q", name: "Support", open: true, oldestWaitSeconds: 31, blendWaitSeconds: 30, reserveAgents: 0, qualified: ["a", "b", "c"] }]);
  assert.deepEqual(h.agentIds, ["a", "b", "c"]);
  assert.equal(h.reasons[0]?.kind, "waiting");
  assert.equal(blendMessage(h), "Inbound priority: holding outbound for 3 agents");
});

test("blending reserves agents while open, nothing when closed or off", () => {
  const base = { queueId: "q", name: "Support", open: true, oldestWaitSeconds: 5, blendWaitSeconds: 30, reserveAgents: 2, qualified: ["a", "b", "c"] };
  assert.deepEqual(blendHolds([base]).agentIds, ["a", "b"]);
  assert.deepEqual(blendHolds([{ ...base, open: false }]).agentIds, []);
  assert.deepEqual(blendHolds([{ ...base, reserveAgents: 0, oldestWaitSeconds: 600, blendWaitSeconds: 0 }]).agentIds, []);
  assert.equal(blendMessage(blendHolds([])), null);
  // Two queues: the union, counted once.
  const two = blendHolds([base, { ...base, queueId: "r", name: "Sales", reserveAgents: 1, qualified: ["b", "d"] }]);
  assert.deepEqual(two.agentIds, ["a", "b"]);
});

test("estimated wait from the gaps between answers in the last hour", () => {
  const now = 10_000_000;
  const answers = [
    { at: now - 600_000, waitSeconds: 40 },
    { at: now - 480_000, waitSeconds: 50 },
    { at: now - 360_000, waitSeconds: 30 },
    { at: now - 4_000_000, waitSeconds: 999 }, // older than an hour: ignored
  ];
  assert.equal(estimateWaitSeconds({ position: 1, answers, now }), 120);
  assert.equal(estimateWaitSeconds({ position: 3, answers, now }), 360);
  assert.equal(estimateWaitSeconds({ position: 2, answers: [{ at: now - 1000, waitSeconds: 45 }], now }), 45);
  assert.equal(estimateWaitSeconds({ position: 2, answers: [], now }), null);
});

test("the announcement names the position and the wait, and can say neither", () => {
  assert.equal(announcementText(2, 150), "You are second in line. Your estimated wait is about 3 minutes. Thank you for holding.");
  assert.equal(announcementText(14, null), "There are 13 callers ahead of you. Thank you for holding.");
  assert.equal(announcementText(1, 20, { position: false, wait: true }), "Your estimated wait is less than a minute. Thank you for holding.");
  assert.equal(announcementText(1, null, { position: false, wait: true }), null);
  assert.equal(waitPhrase(70), "about one minute");
});

test("announcements on entry, then every N seconds (never more often than 15 s)", () => {
  assert.equal(announcementDue(null, 0, 60), true);
  assert.equal(announcementDue(0, 59_000, 60), false);
  assert.equal(announcementDue(0, 60_000, 60), true);
  assert.equal(announcementDue(0, 10_000, 5), false);
});
