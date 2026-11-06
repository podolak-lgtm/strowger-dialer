// Inbound queues: automatic call distribution.
//
// A waiting caller is a member of the Redis sorted set `queue:<id>` with a
// score from `queueScore` (priority, then arrival; aging makes a point worth
// `agingSeconds` of waiting), and `queued:<callId>` holds the facts. A caller
// who asked for a callback stays in the set as `cb:<QueueCallback.id>` at the
// same score. The caller's own leg sits in a jambonz `enqueue` for hold music
// and announcements (`waitHook`); jambonz's queue is only the waiting room,
// the order is ours.
//
// Every second (`queueTick`, one engine at a time) each tenant's waiting
// callers are walked in serving order across all queues (highest effective
// priority first, then arrival), and each takes the first free agent the
// queue's strategy offers (sticky: the agent who last handled the lead, for
// `stickySeconds`). Assigned callers are REST-redirected to `/jambonz/bridge`
// into the agent's room. The same pass overflows callers past
// `maxWaitSeconds`, places queue callbacks, ends inbound wrap-up timers, and
// works out which agents the ratio pacer must leave alone (blending).
import { prisma, type Call, type Queue, type QueueCallback, type Schedule } from "@strowger/db";
import {
  aiOnEntry,
  aiOverflowDue,
  announcementDue,
  announcementText,
  blendHolds,
  blendMessage,
  callerPriority,
  effectivePriority,
  estimateWaitSeconds,
  evaluateSchedule,
  forcedHoldUntil,
  inForcedHold,
  oldestAnswerableWait,
  orderAgents,
  parseHolidays,
  parseWeekly,
  queueScore,
  type BlendHolds,
  type BlendQueue,
  type ScheduleState,
} from "@strowger/shared/inbound";
import { getAgent, listAgents, patchAgent, type AgentLive } from "../agents/state";
import { hookUrl, jambonz } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { audio, boxForQueue, claimAgent, gatherPrompt, isFree, ivrVerbs, joinAgentVerbs, promptVerb, sayVerb, ttsAvailable, voicemailVerbs, type Verbs } from "./common";
import { placeQueueCallback } from "./callbacks";
import { aiEntryVerbs, aiState, aiTakeWaiting } from "./ai/control";

const QKEY = (queueId: string) => `queue:${queueId}`;
const QMETA = (callId: string) => `queued:${callId}`;
const RR = (queueId: string) => `queue:${queueId}:rr`;
const ANSWERS = (queueId: string) => `queue:${queueId}:answers`;
const ANNOUNCED = (callId: string) => `qann:${callId}`;
const OFFERED = (callId: string) => `qcboffer:${callId}`;
const PROMPTING = (callId: string) => `qcbprompt:${callId}`;
const BRIDGING = (callId: string) => `qbridge:${callId}`;
const OVERFLOWED = (callId: string) => `qover:${callId}`;
const HOLDS = (tenantId: string) => `blend:${tenantId}`;
const HOLDS_MSG = (tenantId: string) => `blend:${tenantId}:msg`;
const LIVE = (tenantId: string) => `inbound:live:${tenantId}`;
const callsTodayKey = () => `inbound:answered:${new Date().toISOString().slice(0, 10)}`;
export const CB_MEMBER = (id: string) => `cb:${id}`;
const MAX_DEPTH = 3;

export interface QueueMeta {
  queueId: string;
  tenantId: string;
  /** Entered this queue, ms. */
  at: number;
  priority: number;
  agingSeconds: number;
  leadId: string | null;
  stickyAgentId?: string | null;
  stickyUntil?: number | null;
  /** Forced hold: not offered to any agent before this, ms (shared/inbound/hold.ts). */
  holdUntil?: number | null;
}

export interface EnterOptions {
  /** Already waited or talked (an AI hand-off): no forced hold. */
  exemptHold?: boolean;
  /** Added to the caller's priority (an AI hand-off goes to the front). */
  priorityBoost?: number;
}

type QueueWithSchedule = Queue & { schedule: Schedule | null };
type Requirement = { skillId: string; minLevel: number };

// ── Hours ───────────────────────────────────────────────────────────────────

export function scheduleState(s: Schedule | null | undefined, now = new Date()): ScheduleState {
  if (!s) return { open: true };
  return evaluateSchedule({ timezone: s.timezone, weekly: parseWeekly(s.weekly), holidays: parseHolidays(s.holidays), closedNow: s.closedNow, closedUntil: s.closedUntil, closedNowAudioId: s.closedNowAudioId }, now);
}

const CLOSED_TEXT = "Thank you for calling. We are closed right now. Please call back during our business hours.";

/** The schedule is closed: its greeting (the holiday's or the override's message first), then its after-hours action. */
export async function closedVerbs(schedule: Schedule, state: Exclude<ScheduleState, { open: true }>, callId: string, fromPhone: string, depth = 0): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (call) await prisma.call.update({ where: { id: callId }, data: { notes: call.notes ?? `Closed (${state.reason})`, providerData: { ...(call.providerData as object), closed: state.reason, schedule: schedule.name } } });
  const greetingId = state.audioId ?? schedule.closedGreetingAudioId;
  const greetingUrl = await audio(greetingId);
  const greeting: Verbs = greetingUrl ? [{ verb: "play", url: greetingUrl }] : [];
  const t = schedule.closedTargetId;
  switch (schedule.closedAction) {
    case "VOICEMAIL": {
      const box = t ? await prisma.voicemailBox.findFirst({ where: { id: t, tenantId: schedule.tenantId } }) : null;
      if (box) return [...greeting, ...(await voicemailVerbs(box, callId, fromPhone))];
      break;
    }
    case "IVR": {
      const ivr = t ? await prisma.ivr.findFirst({ where: { id: t, tenantId: schedule.tenantId } }) : null;
      if (ivr) return [...greeting, ...(await ivrVerbs(ivr, callId))];
      break;
    }
    case "QUEUE": {
      const q = t ? await prisma.queue.findFirst({ where: { id: t, tenantId: schedule.tenantId }, include: { schedule: true } }) : null;
      if (q && depth < MAX_DEPTH) return [...greeting, ...(await enterQueue(q, callId, depth + 1))];
      break;
    }
  }
  if (greeting.length) return [...greeting, { verb: "hangup" }];
  const spoken = await promptVerb(null, CLOSED_TEXT);
  return [...(spoken ? [spoken] : []), { verb: "hangup" }];
}

// ── Entering ────────────────────────────────────────────────────────────────

function enqueueVerb(queue: Queue, callId: string): Verbs {
  return [{ verb: "enqueue", name: `q-${queue.id}`, waitHook: hookUrl("/jambonz/queue-wait", { queueId: queue.id, callId }), actionHook: hookUrl("/jambonz/queue-exit", { queueId: queue.id, callId }) }];
}

function requirements(q: Queue): Requirement[] {
  return ((q.requiredSkills as Requirement[] | null) ?? []).filter((r) => r?.skillId);
}

type Ratings = Map<string, Map<string, number>>;

async function loadRatings(userIds: string[]): Promise<Ratings> {
  const m: Ratings = new Map();
  if (userIds.length === 0) return m;
  for (const r of await prisma.agentSkill.findMany({ where: { userId: { in: userIds } } })) {
    if (!m.has(r.userId)) m.set(r.userId, new Map());
    m.get(r.userId)!.set(r.skillId, r.level);
  }
  return m;
}

/** Sum of the agent's levels on the queue's skills, or null when a requirement is not met. */
function ratingFor(q: Queue, userId: string, ratings: Ratings): number | null {
  let total = 0;
  for (const r of requirements(q)) {
    const lvl = ratings.get(userId)?.get(r.skillId) ?? 0;
    if (lvl < (r.minLevel ?? 1)) return null;
    total += lvl;
  }
  return total;
}

/** Agents (from `pool`) who may take this queue's calls. A queue with no skills prefers its campaign's agents when any are in the pool. */
function qualifiedFrom(q: Queue, pool: readonly AgentLive[], ratings: Ratings, preferCampaign = true): Array<{ agent: AgentLive; rating: number }> {
  if (requirements(q).length === 0) {
    const onCampaign = q.campaignId ? pool.filter((a) => a.campaignId === q.campaignId) : [];
    return (preferCampaign && onCampaign.length ? onCampaign : q.campaignId && !preferCampaign ? onCampaign : pool).map((agent) => ({ agent, rating: 0 }));
  }
  return pool.map((agent) => ({ agent, rating: ratingFor(q, agent.userId, ratings) })).filter((x): x is { agent: AgentLive; rating: number } => x.rating !== null);
}

async function liveCount(queueId: string): Promise<number> {
  const members = await redis.zrange(QKEY(queueId), 0, -1);
  return members.filter((m) => !m.startsWith("cb:")).length;
}

/** Put a caller in a queue: hours first, then the limit, then priority, the forced hold and stickiness; hold music from the waitHook. */
export async function enterQueue(queue: Queue & { schedule?: Schedule | null }, callId: string, depth = 0, opts: EnterOptions = {}): Promise<Verbs> {
  const q: QueueWithSchedule = queue.schedule !== undefined ? (queue as QueueWithSchedule) : await prisma.queue.findUniqueOrThrow({ where: { id: queue.id }, include: { schedule: true } });
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: true } });
  if (!call) return [{ verb: "hangup" }];
  const st = scheduleState(q.schedule);
  // AI answer (inbound/ai): FIRST and ONLY take every caller; OVERFLOW when closed or nobody qualified is logged in.
  // A call the AI has already had (a hand-off, a fallback) never goes back to it.
  if (q.aiEnabled && !(call.providerData as { ai?: unknown } | null)?.ai) {
    const onFloor = (await listAgents(q.tenantId)).filter((a) => a.state !== "LOGGED_OUT");
    const qualifiedOnFloor = qualifiedFrom(q, onFloor, await loadRatings(onFloor.map((a) => a.userId)), false).length;
    if (aiOnEntry({ enabled: true, ready: true, alreadyHandled: false, mode: q.aiMode, open: st.open, qualifiedOnFloor })) {
      const reason = !st.open ? "queue closed" : q.aiMode === "OVERFLOW" ? "no agents on the floor" : "answers first";
      const verbs = await aiEntryVerbs(q, callId, reason);
      if (verbs) return verbs;
    }
  }
  if (!st.open && q.schedule) return closedVerbs(q.schedule, st, callId, call.phone, depth);
  if (q.maxWaiting > 0 && (await liveCount(q.id)) >= q.maxWaiting) {
    log.info({ queueId: q.id, callId, maxWaiting: q.maxWaiting }, "queue full");
    await prisma.call.update({ where: { id: callId }, data: { notes: `Queue ${q.name} full` } });
    return fullVerbs(q, call, depth);
  }
  const lead = call.lead;
  const now = Date.now();
  const priority = callerPriority(q, { vip: Boolean(lead?.vip), knownLead: Boolean(lead) }) + (opts.priorityBoost ?? 0);
  // Forced hold, counted from the caller's first queue (an overflow does not start it again).
  const firstQueuedAt = call.queuedAt?.getTime() ?? now;
  const exempt = opts.exemptHold || Boolean((call.providerData as { aiHandoff?: unknown } | null)?.aiHandoff);
  const holdUntil = forcedHoldUntil({ queuedAt: firstQueuedAt, minHoldSeconds: q.minHoldSeconds, vip: Boolean(lead?.vip), bypassVip: q.minHoldBypassVip, exempt });
  const meta: QueueMeta = { queueId: q.id, tenantId: q.tenantId, at: now, priority, agingSeconds: q.agingSeconds, leadId: lead?.id ?? null, holdUntil };
  // Sticky: the agent who last handled this lead gets the first offer, if they are on the floor and qualified.
  // The window opens when the caller may be answered (after any forced hold).
  if (q.stickySeconds > 0 && lead?.lastAgentId) {
    const last = await getAgent(lead.lastAgentId);
    if (last && last.tenantId === q.tenantId && last.state !== "LOGGED_OUT" && qualifiedFrom(q, [last], await loadRatings([last.userId]), false).length) {
      meta.stickyAgentId = last.userId;
      meta.stickyUntil = Math.max(now, holdUntil ?? 0) + q.stickySeconds * 1000;
    }
  }
  await redis.zadd(QKEY(q.id), queueScore(now, priority, q.agingSeconds), callId);
  await redis.set(QMETA(callId), JSON.stringify(meta), "EX", 6 * 3600);
  await prisma.call.update({
    where: { id: callId },
    data: {
      queueId: q.id,
      queuedAt: call.queuedAt ?? new Date(now),
      forcedHoldSeconds: holdUntil ? Math.round((holdUntil - firstQueuedAt) / 1000) : null,
      providerData: { ...(call.providerData as object), queueId: q.id, queuedAt: new Date(now).toISOString(), priority, ...(holdUntil ? { holdUntil: new Date(holdUntil).toISOString() } : {}) },
    },
  });
  if (holdUntil) log.info({ queueId: q.id, callId, holdSeconds: Math.round((holdUntil - now) / 1000) }, "queue forced hold");
  emitToTenant(q.tenantId, "floor:queue", { queueId: q.id, callId, event: "join" });
  return enqueueVerb(q, callId);
}

async function fullVerbs(q: Queue, call: Call, depth: number): Promise<Verbs> {
  if (q.fullAction === "QUEUE" && q.overflowQueueId && depth < MAX_DEPTH) {
    const next = await prisma.queue.findFirst({ where: { id: q.overflowQueueId, tenantId: q.tenantId }, include: { schedule: true } });
    if (next) return enterQueue(next, call.id, depth + 1);
  }
  if (q.fullAction === "VOICEMAIL") return voicemailVerbs(await boxForQueue(q), call.id, call.phone);
  const p = await promptVerb(null, "All of our agents are busy right now. Please call back shortly. Goodbye.");
  return [...(p ? [p] : []), { verb: "hangup" }];
}

/** Leave the waiting room. `hangup` = the caller gave up: counted as abandoned in the queue. */
export async function leaveQueue(callId: string, reason: "hangup" | "assigned" | "overflow" | "callback" | "ai" | "other" = "other"): Promise<void> {
  const raw = await redis.get(QMETA(callId));
  if (!raw) return;
  const meta = JSON.parse(raw) as QueueMeta;
  await redis.zrem(QKEY(meta.queueId), callId);
  await redis.del(QMETA(callId), ANNOUNCED(callId), OFFERED(callId), PROMPTING(callId));
  if (reason === "hangup") {
    const now = Date.now();
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { queuedAt: true } }).catch(() => null);
    const since = call?.queuedAt?.getTime() ?? meta.at;
    await prisma.call.updateMany({ where: { id: callId, agentId: null }, data: { abandonedInQueue: true, abandonedInForcedHold: inForcedHold(meta.holdUntil, now), waitSeconds: Math.round((now - since) / 1000) } }).catch(() => undefined);
  }
  emitToTenant(meta.tenantId, "floor:queue", { queueId: meta.queueId, callId, event: "leave", reason });
}

// ── While waiting ───────────────────────────────────────────────────────────

async function recentAnswers(queueId: string, now: number): Promise<Array<{ at: number; waitSeconds: number }>> {
  const rows = await redis.zrangebyscore(ANSWERS(queueId), now - 3_600_000, now, "WITHSCORES");
  const out: Array<{ at: number; waitSeconds: number }> = [];
  for (let i = 0; i < rows.length; i += 2) out.push({ at: Number(rows[i + 1]), waitSeconds: Number(rows[i]!.split(":").pop()) || 0 });
  return out;
}

/** jambonz asks on entry and each time the previous verbs finish: announcement, hold music, or the callback offer. */
export async function queueWaitVerbs(queueId: string, callId: string | undefined): Promise<Verbs> {
  const q = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!q) return [{ verb: "pause", length: 15 }];
  const raw = callId ? await redis.get(QMETA(callId)) : null;
  const meta = raw ? (JSON.parse(raw) as QueueMeta) : null;
  const now = Date.now();
  // Not ours any more (an agent took it, the redirect is in flight): wait quietly.
  if (!callId || !meta) return [{ verb: "pause", length: 2 }];
  const waitedMs = now - meta.at;

  const offerAt = q.callbackOfferAfterSeconds * 1000;
  const offerPending = q.callbackEnabled && !(await redis.get(OFFERED(callId)));
  if (offerPending && waitedMs >= offerAt) {
    await redis.set(OFFERED(callId), "1", "EX", 6 * 3600);
    await redis.set(PROMPTING(callId), "1", "EX", 300);
    // `leave` ends the enqueue; its actionHook (queue-exit) plays the offer and keeps the caller's place.
    return [{ verb: "leave" }];
  }

  const verbs: Verbs = [];
  if (q.announce) {
    const last = Number(await redis.get(ANNOUNCED(callId))) || null;
    if (announcementDue(last, now, q.announceEverySeconds) && (await ttsAvailable())) {
      const rank = await redis.zrank(QKEY(q.id), callId);
      const position = rank === null ? 1 : rank + 1;
      const ewt = estimateWaitSeconds({ position, answers: await recentAnswers(q.id, now), now });
      const text = announcementText(position, ewt, { position: q.announcePosition, wait: q.announceWait });
      if (text) verbs.push(sayVerb(text));
      await redis.set(ANNOUNCED(callId), String(now), "EX", 6 * 3600);
    }
  }
  // Hold music runs until the next announcement or the callback offer, whichever comes first.
  const until: number[] = [];
  if (q.announce) until.push(Math.max(15, q.announceEverySeconds));
  if (offerPending) until.push(Math.max(5, Math.ceil((offerAt - waitedMs) / 1000)));
  const holdSecs = until.length ? Math.min(...until) : null;
  const hold = await audio(q.holdAudioId);
  if (hold) verbs.push(holdSecs ? { verb: "play", url: hold, timeoutSecs: holdSecs } : { verb: "play", url: hold });
  else verbs.push({ verb: "pause", length: Math.min(holdSecs ?? 15, 15) });
  return verbs;
}

const CALLBACK_OFFER = "To get a call back without losing your place in line, press 1. To keep holding, stay on the line.";

/** The enqueue ended. After our own `leave` that is the callback offer; after a bridge redirect, the bridge. */
export async function queueExitVerbs(queueId: string, callId: string, result: string | undefined): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return [{ verb: "hangup" }];
  // The caller was moved to the AI answer (OVERFLOW) and this hook raced the redirect: nothing, so the AI session stands.
  if (await aiState(callId)) return [];
  // An agent took the call and the REST redirect raced this hook: answer with the bridge, never a hangup.
  const agentId = await redis.get(BRIDGING(callId));
  if (agentId) return joinAgentVerbs(callId, call.tenantId, agentId);
  if (result === "leave" && (await redis.get(PROMPTING(callId)))) {
    await redis.del(PROMPTING(callId));
    const q = await prisma.queue.findUnique({ where: { id: queueId } });
    if (q) {
      return [
        { verb: "gather", input: ["digits"], numDigits: 1, timeout: 6, actionHook: hookUrl("/jambonz/queue-callback", { queueId, callId }), ...(await gatherPrompt(q.callbackAudioId, CALLBACK_OFFER)) },
        { verb: "redirect", actionHook: hookUrl("/jambonz/queue-callback", { queueId, callId, timeout: "1" }) },
      ];
    }
  }
  const overflow = await redis.get(OVERFLOWED(callId));
  if (overflow) return JSON.parse(overflow) as Verbs;
  if (result === "hangup") {
    await leaveQueue(callId, "hangup");
    return [{ verb: "hangup" }];
  }
  // Still waiting in our queue (a leave we did not ask for, an error): back to the hold music, same place.
  const q = await prisma.queue.findUnique({ where: { id: queueId } });
  if (q && (await redis.zscore(QKEY(queueId), callId)) !== null) return enqueueVerb(q, callId);
  return [{ verb: "hangup" }];
}

/** The caller's answer to the callback offer: 1 books it and keeps their place; anything else back to holding. */
export async function queueCallbackChoice(queueId: string, callId: string, digits: string): Promise<Verbs> {
  const q = await prisma.queue.findUnique({ where: { id: queueId } });
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!q || !call) return [{ verb: "hangup" }];
  const agentId = await redis.get(BRIDGING(callId));
  if (agentId) return joinAgentVerbs(callId, call.tenantId, agentId);
  const score = await redis.zscore(QKEY(q.id), callId);
  if (digits !== "1" || score === null) return score === null ? [{ verb: "hangup" }] : enqueueVerb(q, callId);
  const raw = await redis.get(QMETA(callId));
  const meta = raw ? (JSON.parse(raw) as QueueMeta) : null;
  const cb = await prisma.queueCallback.create({
    data: { tenantId: q.tenantId, queueId: q.id, phone: call.phone, leadId: call.leadId, callerId: call.callerId ?? "", originalCallId: call.id, score: Number(score), priority: meta?.priority ?? 0, requestedAt: meta ? new Date(meta.at) : new Date() },
  });
  await redis.multi().zrem(QKEY(q.id), callId).zadd(QKEY(q.id), score, CB_MEMBER(cb.id)).del(QMETA(callId), ANNOUNCED(callId), OFFERED(callId), PROMPTING(callId)).exec();
  await prisma.call.update({
    where: { id: callId },
    data: { outcome: "CANCELLED", notes: `Asked for a queue callback (${q.name})`, waitSeconds: meta ? Math.round((Date.now() - meta.at) / 1000) : null, providerData: { ...(call.providerData as object), askedQueueCallbackId: cb.id } },
  });
  log.info({ queueId: q.id, callId, queueCallbackId: cb.id }, "queue callback requested");
  emitToTenant(q.tenantId, "floor:queue", { queueId: q.id, callId, event: "callback" });
  const thanks = await promptVerb(null, "Thank you. We will call you back at this number when it is your turn. Goodbye.");
  return [...(thanks ? [thanks] : []), { verb: "hangup" }];
}

// ── Overflow ────────────────────────────────────────────────────────────────

/** Overflow verbs, worked out once per call: the redirect and the enqueue's exit hook may both ask (a voicemail row is created once). */
export async function overflowVerbs(queueId: string, callId: string, depth = 0): Promise<Verbs> {
  const cached = await redis.get(OVERFLOWED(callId));
  if (cached) return JSON.parse(cached) as Verbs;
  const verbs = await computeOverflow(queueId, callId, depth);
  await redis.set(OVERFLOWED(callId), JSON.stringify(verbs), "EX", 120);
  return verbs;
}

async function computeOverflow(queueId: string, callId: string, depth: number): Promise<Verbs> {
  const q = await prisma.queue.findUnique({ where: { id: queueId } });
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!q || !call) return [{ verb: "hangup" }];
  if (q.overflowAction === "QUEUE" && q.overflowQueueId && depth < MAX_DEPTH) {
    const next = await prisma.queue.findUnique({ where: { id: q.overflowQueueId }, include: { schedule: true } });
    if (next) {
      await redis.del(OVERFLOWED(callId));
      return enterQueue(next, callId, depth + 1);
    }
  }
  if (q.overflowAction === "VOICEMAIL") return voicemailVerbs(await boxForQueue(q), callId, call.phone);
  return [{ verb: "hangup" }];
}

// ── Wrap-up ─────────────────────────────────────────────────────────────────

/**
 * An inbound queue call ended for the agent: WRAP_UP, and back to Ready after
 * the queue's `wrapUpSeconds` unless they pause (0 = until the disposition; a
 * queue without a campaign has no dispositions, so it gets 30 s).
 */
export async function wrapAfterQueueCall(call: Pick<Call, "id" | "agentId" | "queueId" | "campaignId">): Promise<void> {
  if (!call.agentId) return;
  // Already wrapping this call on a timer (the survey started it when the agent left): keep that timer.
  const live = await getAgent(call.agentId);
  if (live?.state === "WRAP_UP" && live.wrapUntil && live.currentCallId === call.id) return;
  const q = call.queueId ? await prisma.queue.findUnique({ where: { id: call.queueId }, select: { wrapUpSeconds: true } }) : null;
  const secs = q ? q.wrapUpSeconds || (call.campaignId ? 0 : 30) : 0;
  await patchAgent(call.agentId, { state: "WRAP_UP", wrapUntil: secs > 0 ? Date.now() + secs * 1000 : null });
}

async function wrapTick(agents: AgentLive[], now: number): Promise<void> {
  for (const a of agents) {
    if (!a.wrapUntil || now < a.wrapUntil) continue;
    const callId = a.currentCallId;
    if (a.state === "WRAP_UP") {
      const paused = a.afterCall === "PAUSED" || !a.agentCallSid;
      await patchAgent(a.userId, { state: paused ? "PAUSED" : "READY", currentCallId: null, afterCall: null, wrapUntil: null, pauseReason: paused ? (a.agentCallSid ? (a.pauseReason ?? "Manual dial") : "Line dropped") : null });
    } else if (a.state === "PAUSED") {
      // They paused during wrap-up: they stay paused, the call is done.
      await patchAgent(a.userId, { currentCallId: null, afterCall: null, wrapUntil: null });
    } else {
      await patchAgent(a.userId, { wrapUntil: null });
      continue;
    }
    if (callId) {
      await prisma.call.updateMany({ where: { id: callId, wrapEndedAt: null }, data: { wrapEndedAt: new Date(now) } });
      emitToAgent(a.userId, "call:update", { callId, status: "wrapped" });
    }
  }
}

// ── Distribution ────────────────────────────────────────────────────────────

interface Waiting {
  q: QueueWithSchedule;
  member: string;
  arrivalMs: number;
  priority: number;
  meta: QueueMeta | null;
  call: Call | null;
  cb: QueueCallback | null;
}

async function assignCaller(q: Queue, w: Waiting, agent: AgentLive, now: number): Promise<void> {
  const call = w.call!;
  const waited = Math.round((now - w.arrivalMs) / 1000);
  await leaveQueue(call.id, "assigned");
  await redis.set(BRIDGING(call.id), agent.userId, "EX", 120);
  // A caller handed over by the AI answer: its summary and transcript go up with the screen pop.
  const ai = call.aiHandledAt ? { aiSummary: call.aiSummary ?? "The automated assistant spoke with this caller first.", aiTranscript: ((call.aiTranscript as Array<{ role: string; text: string }> | null) ?? []).slice(-12).map((t) => ({ role: t.role, text: t.text })) } : {};
  await claimAgent(agent, call.id, call.leadId, { queue: q.name, waitedSeconds: waited, from: call.phone, ...ai });
  await prisma.call.update({ where: { id: call.id }, data: { waitSeconds: waited } });
  await recordAnswer(q.id, call.id, waited, agent.userId, now);
  log.info({ queueId: q.id, callId: call.id, agentId: agent.userId, waited, strategy: q.strategy, sticky: w.meta?.stickyAgentId === agent.userId }, "queue caller assigned");
  if (call.providerCallId) {
    await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/bridge", { callId: call.id, agentId: agent.userId }), method: "POST" }).catch((e) => log.warn({ err: e, callId: call.id }, "queue bridge redirect failed"));
  }
}

/** One answer for the queue's moving averages, the round-robin pointer and the agent's calls today. */
export async function recordAnswer(queueId: string, callId: string, waitSeconds: number, agentId: string, now = Date.now()): Promise<void> {
  await redis.zadd(ANSWERS(queueId), now, `${callId}:${waitSeconds}`);
  await redis.zremrangebyscore(ANSWERS(queueId), 0, now - 3_600_000);
  await redis.expire(ANSWERS(queueId), 7200);
  await redis.set(RR(queueId), agentId, "EX", 86_400);
  await redis.hincrby(callsTodayKey(), agentId, 1);
  await redis.expire(callsTodayKey(), 2 * 86_400);
}

export interface QueueLive {
  queueId: string;
  name: string;
  open: boolean;
  closedReason: string | null;
  waiting: number;
  /** Of `waiting`, still inside the forced hold. */
  inForcedHold: number;
  callbacksWaiting: number;
  longestWaitSeconds: number;
  available: number;
  onCall: number;
  wrapUp: number;
  slaSeconds: number;
}

export interface InboundLive {
  at: number;
  queues: QueueLive[];
  holds: BlendHolds & { message: string | null };
}

async function tickTenant(tenantId: string, queues: QueueWithSchedule[], now: number): Promise<void> {
  const agents = await listAgents(tenantId);
  await wrapTick(agents, now);
  const fresh = agents.some((a) => a.wrapUntil && now >= a.wrapUntil) ? await listAgents(tenantId) : agents;
  const ratings = await loadRatings(fresh.map((a) => a.userId));
  const callsToday = await redis.hgetall(callsTodayKey());

  const waiting: Waiting[] = [];
  const openOf = new Map<string, ScheduleState>();
  for (const q of queues) {
    openOf.set(q.id, scheduleState(q.schedule, new Date(now)));
    const rows = await redis.zrange(QKEY(q.id), 0, -1, "WITHSCORES");
    for (let i = 0; i < rows.length; i += 2) {
      const member = rows[i]!;
      if (member.startsWith("cb:")) {
        const cb = await prisma.queueCallback.findUnique({ where: { id: member.slice(3) } });
        if (!cb || cb.status !== "WAITING") {
          await redis.zrem(QKEY(q.id), member);
          continue;
        }
        waiting.push({ q, member, arrivalMs: cb.requestedAt.getTime(), priority: cb.priority, meta: null, call: null, cb });
        continue;
      }
      const call = await prisma.call.findUnique({ where: { id: member } });
      if (!call?.providerCallId || call.endedAt) {
        await leaveQueue(member, "hangup");
        await redis.zrem(QKEY(q.id), member);
        continue;
      }
      const raw = await redis.get(QMETA(member));
      const meta = raw ? (JSON.parse(raw) as QueueMeta) : null;
      const arrivalMs = meta?.at ?? call.queuedAt?.getTime() ?? now;
      if (now - arrivalMs > q.maxWaitSeconds * 1000) {
        await leaveQueue(member, "overflow");
        await redis.zrem(QKEY(q.id), member);
        log.info({ queueId: q.id, callId: member, waited: Math.round((now - arrivalMs) / 1000) }, "queue overflow");
        await prisma.call.update({ where: { id: member }, data: { waitSeconds: Math.round((now - arrivalMs) / 1000) } });
        await overflowVerbs(q.id, member); // worked out now, so the exit hook and the redirect agree
        await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/overflow", { queueId: q.id, callId: member }), method: "POST" }).catch((e) => log.warn({ err: e, callId: member }, "queue overflow redirect failed"));
        continue;
      }
      waiting.push({ q, member, arrivalMs, priority: meta?.priority ?? 0, meta, call, cb: null });
    }
  }

  // Serving order across every queue: highest priority now (aging included), then who came first.
  waiting.sort((a, b) => effectivePriority(b.priority, b.arrivalMs, b.q.agingSeconds, now) - effectivePriority(a.priority, a.arrivalMs, a.q.agingSeconds, now) || a.arrivalMs - b.arrivalMs);
  const taken = new Set<string>();
  for (const w of waiting) {
    const pool = fresh.filter((a) => isFree(a) && !taken.has(a.userId));
    if (pool.length === 0) break;
    if (w.cb && !openOf.get(w.q.id)?.open) continue; // callbacks wait for the queue to open
    if (inForcedHold(w.meta?.holdUntil, now)) continue; // forced hold: nobody is offered this caller yet
    let cands = qualifiedFrom(w.q, pool, ratings);
    const sticky = w.meta?.stickyAgentId && w.meta.stickyUntil && now < w.meta.stickyUntil ? w.meta.stickyAgentId : null;
    if (sticky) cands = cands.filter((c) => c.agent.userId === sticky);
    if (cands.length === 0) continue;
    const ordered = orderAgents(
      w.q.strategy,
      cands.map((c) => ({ userId: c.agent.userId, idleSince: c.agent.since, rating: c.rating, callsToday: Number(callsToday[c.agent.userId] ?? 0), agent: c.agent })),
      await redis.get(RR(w.q.id)),
    );
    const agent = ordered[0]!.agent;
    if (w.cb) {
      if (await placeQueueCallback(w.q, w.cb, agent)) taken.add(agent.userId);
      continue;
    }
    await assignCaller(w.q, w, agent, now);
    taken.add(agent.userId);
  }

  // Blending and the wallboard's live numbers.
  const after = taken.size ? await listAgents(tenantId) : fresh;
  const onFloor = after.filter((a) => a.state !== "LOGGED_OUT");
  const blend: BlendQueue[] = [];
  const live: QueueLive[] = [];
  for (const q of queues) {
    const st = openOf.get(q.id)!;
    const still: Waiting[] = [];
    for (const w of waiting) if (w.q.id === q.id && (await redis.zscore(QKEY(q.id), w.member)) !== null) still.push(w);
    const stillWaiting = still.filter((w) => w.call);
    const oldest = stillWaiting.length ? Math.max(...stillWaiting.map((w) => (now - w.arrivalMs) / 1000)) : null;
    // Blending counts from the end of the forced hold: nobody may answer a held caller yet.
    const oldestAnswerable = oldestAnswerableWait(stillWaiting.map((w) => ({ arrivalMs: w.arrivalMs, holdUntil: w.meta?.holdUntil ?? null })), now);
    const qualified = qualifiedFrom(q, onFloor, ratings, false)
      .map((x) => x.agent)
      .sort((a, b) => Number(isFree(b)) - Number(isFree(a)) || a.since - b.since);
    // AI answer, OVERFLOW: a caller past the forced hold, with no qualified agent free, who has waited aiAfterSeconds.
    if (q.aiEnabled && q.aiMode === "OVERFLOW") {
      const free = qualified.filter(isFree).length;
      for (const w of stillWaiting) {
        if ((w.call?.providerData as { ai?: unknown } | null)?.ai) continue;
        if (!aiOverflowDue({ enabled: true, ready: true, mode: "OVERFLOW", inForcedHold: inForcedHold(w.meta?.holdUntil, now), waitedSeconds: (now - w.arrivalMs) / 1000, afterSeconds: q.aiAfterSeconds, freeQualified: free })) continue;
        if (await aiTakeWaiting(q, w.member, "waited past the limit")) await leaveQueue(w.member, "ai");
      }
    }
    blend.push({ queueId: q.id, name: q.name, open: st.open, oldestWaitSeconds: oldestAnswerable, blendWaitSeconds: q.blendWaitSeconds, reserveAgents: q.reserveAgents, qualified: qualified.map((a) => a.userId) });
    live.push({
      queueId: q.id,
      name: q.name,
      open: st.open,
      closedReason: st.open ? null : st.reason,
      waiting: stillWaiting.length,
      inForcedHold: stillWaiting.filter((w) => inForcedHold(w.meta?.holdUntil, now)).length,
      callbacksWaiting: still.filter((w) => w.cb).length,
      longestWaitSeconds: Math.round(oldest ?? 0),
      available: qualified.filter(isFree).length,
      onCall: qualified.filter((a) => a.state === "ON_CALL").length,
      wrapUp: qualified.filter((a) => a.state === "WRAP_UP").length,
      slaSeconds: q.slaSeconds,
    });
  }
  const holds = blendHolds(blend);
  const message = blendMessage(holds);
  await redis.set(HOLDS(tenantId), JSON.stringify(holds), "EX", 10);
  const lastMsg = await redis.get(HOLDS_MSG(tenantId));
  if ((lastMsg ?? "") !== (message ?? "")) {
    await redis.set(HOLDS_MSG(tenantId), message ?? "", "EX", 3600);
    log.info({ tenantId, holds: holds.agentIds.length, reasons: holds.reasons }, message ?? "Inbound priority: outbound released");
    emitToTenant(tenantId, "floor:blend", { message, reasons: holds.reasons });
  }
  const snapshot: InboundLive = { at: now, queues: live, holds: { ...holds, message } };
  await redis.set(LIVE(tenantId), JSON.stringify(snapshot), "EX", 10);
}

/** Every second: hand waiting callers to agents; overflow; queue callbacks; wrap-up timers; blending. */
export async function queueTick(): Promise<void> {
  const queues = await prisma.queue.findMany({ include: { schedule: true } });
  const byTenant = new Map<string, QueueWithSchedule[]>();
  for (const q of queues) byTenant.set(q.tenantId, [...(byTenant.get(q.tenantId) ?? []), q]);
  const now = Date.now();
  for (const [tenantId, qs] of byTenant) {
    await tickTenant(tenantId, qs, now).catch((e) => log.error({ err: e, tenantId }, "queue tick failed for tenant"));
  }
}

/** Agents the ratio pacer must not launch outbound calls for (blending). Empty when the queue tick has not run. */
export async function inboundHolds(tenantId: string): Promise<Set<string>> {
  const raw = await redis.get(HOLDS(tenantId));
  return new Set(raw ? (JSON.parse(raw) as BlendHolds).agentIds : []);
}

export async function inboundLive(tenantId: string): Promise<InboundLive | null> {
  const raw = await redis.get(LIVE(tenantId));
  return raw ? (JSON.parse(raw) as InboundLive) : null;
}

/** Put a queue callback back in line at its old place (an attempt failed). */
export async function requeueCallback(cb: QueueCallback): Promise<void> {
  await redis.zadd(QKEY(cb.queueId), cb.score, CB_MEMBER(cb.id));
}

export async function removeCallbackMember(cb: Pick<QueueCallback, "id" | "queueId">): Promise<void> {
  await redis.zrem(QKEY(cb.queueId), CB_MEMBER(cb.id));
}
