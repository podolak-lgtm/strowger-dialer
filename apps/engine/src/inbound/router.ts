// Inbound contact center: where a call to one of our numbers goes.
//
//   number.routeTo = CAMPAIGN  a lead calling back → owning / next Ready agent
//                    USER      a direct DID → that agent, else their voicemail
//                    IVR       menu → options, extensions, voicemail
//                    QUEUE     skills-based waiting room → best qualified agent
//
// Queues live in Redis (sorted set per queue, score = enqueue time); a 1 s
// tick assigns callers to agents as they become Ready and handles overflow.
import { prisma, type Ivr, type Queue, type VoicemailBox } from "@strowger/db";
import { normalizePhone } from "@strowger/shared/phone";
import { getAgent, listAgents, patchAgent, type AgentLive } from "../agents/state";
import { config } from "../config";
import { agentRoom, hookUrl, jambonz } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";

type Verb = Record<string, unknown>;
export type Verbs = Verb[];

const QKEY = (queueId: string) => `queue:${queueId}`;
const QMETA = (callId: string) => `queued:${callId}`;

async function audio(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const a = await prisma.audioAsset.findUnique({ where: { id } });
  return a?.storageUrl ?? null;
}

/** Conference-join verbs for an inbound caller into an agent's room. */
export function joinAgentVerbs(callId: string, tenantId: string, agentId: string): Verbs {
  return [
    { verb: "conference", name: agentRoom(agentId), memberTag: "lead", startConferenceOnEnter: false, endConferenceOnExit: false, beep: false, statusHook: hookUrl("/jambonz/conf", { callId, tenantId }), statusEvents: ["join", "leave"], actionHook: hookUrl("/jambonz/conf-exit", { callId }) },
    { verb: "hangup" },
  ];
}

async function claimAgent(agent: AgentLive, callId: string, leadId: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.call.update({ where: { id: callId }, data: { agentId: agent.userId } });
  await patchAgent(agent.userId, { state: "ON_CALL", currentCallId: callId, reservedLeadId: null });
  if (leadId) await prisma.lead.update({ where: { id: leadId }, data: { ownerId: agent.userId } });
  emitToAgent(agent.userId, "call:update", { callId, status: "answered", leadId, inbound: true, ...extra });
  emitToTenant(agent.tenantId, "floor:call", { callId, status: "inbound", agentId: agent.userId });
}

function isFree(a: AgentLive): boolean {
  return a.state === "READY" && Boolean(a.agentCallSid) && !a.currentCallId && !a.reservedLeadId;
}

// ── Skills ──────────────────────────────────────────────────────────────────

type Requirement = { skillId: string; minLevel: number };

/** Free agents who satisfy every requirement, best rated first, then longest idle. */
export async function qualifiedAgents(tenantId: string, queue: Queue): Promise<AgentLive[]> {
  const free = (await listAgents(tenantId)).filter(isFree);
  if (free.length === 0) return [];
  const req = ((queue.requiredSkills as Requirement[] | null) ?? []).filter((r) => r.skillId);
  if (req.length === 0) {
    const onCampaign = queue.campaignId ? free.filter((a) => a.campaignId === queue.campaignId) : [];
    return (onCampaign.length ? onCampaign : free).sort((a, b) => a.since - b.since);
  }
  const ratings = await prisma.agentSkill.findMany({ where: { userId: { in: free.map((a) => a.userId) }, skillId: { in: req.map((r) => r.skillId) } } });
  const scored = free
    .map((a) => {
      let total = 0;
      for (const r of req) {
        const lvl = ratings.find((x) => x.userId === a.userId && x.skillId === r.skillId)?.level ?? 0;
        if (lvl < (r.minLevel ?? 1)) return null;
        total += lvl;
      }
      return { a, total };
    })
    .filter((x): x is { a: AgentLive; total: number } => x !== null);
  scored.sort((x, y) => y.total - x.total || x.a.since - y.a.since);
  return scored.map((x) => x.a);
}

// ── Voicemail ───────────────────────────────────────────────────────────────

export async function boxForUser(tenantId: string, userId: string): Promise<VoicemailBox> {
  const existing = await prisma.voicemailBox.findFirst({ where: { tenantId, ownerId: userId } });
  if (existing) return existing;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return prisma.voicemailBox.create({ data: { tenantId, ownerId: userId, name: `${u.firstName ?? u.email}'s voicemail` } });
}

/** Greeting, beep, then stream the caller's audio to our recorder. */
export async function voicemailVerbs(box: VoicemailBox, callId: string, fromPhone: string): Promise<Verbs> {
  const vm = await prisma.voicemail.create({ data: { tenantId: box.tenantId, boxId: box.id, callId, fromPhone, assigneeId: box.ownerId } });
  const greeting = await audio(box.greetingAudioId);
  const wsBase = config.ENGINE_PUBLIC_URL.replace(/^http/, "ws");
  return [
    ...(greeting ? [{ verb: "play", url: greeting }] : [{ verb: "pause", length: 1 }]),
    { verb: "play", url: `${config.WEB_PUBLIC_URL}/beep.wav` },
    { verb: "listen", url: `${wsBase}/audio/voicemail?vmId=${vm.id}`, sampleRate: 8000, timeout: 120, finishOnKey: "#", mixType: "mono", playBeep: false },
    { verb: "hangup" },
  ];
}

// ── IVR ─────────────────────────────────────────────────────────────────────

type IvrOption = { digit: string; label?: string; action: "QUEUE" | "USER" | "VOICEMAIL" | "IVR" | "HANGUP"; targetId?: string | null };

export async function ivrVerbs(ivr: Ivr, callId: string, attempt = 1): Promise<Verbs> {
  const greeting = await audio(ivr.greetingAudioId);
  return [
    {
      verb: "gather",
      input: ["digits"],
      numDigits: ivr.allowExtensions ? 4 : 1,
      finishOnKey: "#",
      timeout: ivr.timeoutSeconds,
      interDigitTimeout: 2,
      actionHook: hookUrl("/jambonz/ivr", { ivrId: ivr.id, callId, attempt: String(attempt) }),
      ...(greeting ? { play: { url: greeting } } : {}),
    },
    { verb: "redirect", actionHook: hookUrl("/jambonz/ivr", { ivrId: ivr.id, callId, attempt: String(attempt + 1), timeout: "1" }) },
  ];
}

/** Apply an IVR option (or the timeout action) to a live call. */
export async function applyAction(tenantId: string, callId: string, action: string, targetId: string | null | undefined, fromPhone: string): Promise<Verbs> {
  switch (action) {
    case "QUEUE": {
      const q = targetId ? await prisma.queue.findFirst({ where: { id: targetId, tenantId } }) : null;
      return q ? enqueueVerbs(q, callId) : [{ verb: "hangup" }];
    }
    case "USER":
      return targetId ? ringUser(tenantId, targetId, callId, fromPhone) : [{ verb: "hangup" }];
    case "VOICEMAIL": {
      const box = targetId ? await prisma.voicemailBox.findFirst({ where: { id: targetId, tenantId } }) : null;
      return box ? voicemailVerbs(box, callId, fromPhone) : [{ verb: "hangup" }];
    }
    case "IVR": {
      const ivr = targetId ? await prisma.ivr.findFirst({ where: { id: targetId, tenantId } }) : null;
      return ivr ? ivrVerbs(ivr, callId) : [{ verb: "hangup" }];
    }
    default:
      return [{ verb: "hangup" }];
  }
}

export async function ivrResult(ivrId: string, callId: string, digits: string, attempt: number, timedOut: boolean): Promise<Verbs> {
  const ivr = await prisma.ivr.findUnique({ where: { id: ivrId } });
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!ivr || !call) return [{ verb: "hangup" }];
  const options = ((ivr.options as IvrOption[] | null) ?? []).filter((o) => o.digit);
  if (digits) {
    const opt = options.find((o) => o.digit === digits);
    if (opt) {
      await prisma.call.update({ where: { id: callId }, data: { providerData: { ...(call.providerData as object), ivr: ivr.name, choice: opt.label ?? opt.digit } } });
      return applyAction(ivr.tenantId, callId, opt.action, opt.targetId, call.phone);
    }
    if (ivr.allowExtensions) {
      const user = await prisma.user.findFirst({ where: { tenantId: ivr.tenantId, extension: digits, active: true } });
      if (user) return ringUser(ivr.tenantId, user.id, callId, call.phone);
    }
  }
  if (attempt <= ivr.repeats && !(timedOut && attempt > ivr.repeats)) return ivrVerbs(ivr, callId, attempt + 1);
  return applyAction(ivr.tenantId, callId, ivr.timeoutAction, ivr.timeoutTargetId, call.phone);
}

// ── Direct to an agent ──────────────────────────────────────────────────────

export async function ringUser(tenantId: string, userId: string, callId: string, fromPhone: string): Promise<Verbs> {
  const live = await getAgent(userId);
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (live && isFree(live)) {
    await claimAgent(live, callId, call?.leadId ?? null, { direct: true, from: fromPhone });
    return joinAgentVerbs(callId, tenantId, userId);
  }
  const box = await boxForUser(tenantId, userId);
  return voicemailVerbs(box, callId, fromPhone);
}

// ── Queues ──────────────────────────────────────────────────────────────────

export async function enqueueVerbs(queue: Queue, callId: string): Promise<Verbs> {
  await redis.zadd(QKEY(queue.id), Date.now(), callId);
  await redis.set(QMETA(callId), JSON.stringify({ queueId: queue.id, tenantId: queue.tenantId, at: Date.now() }), "EX", 6 * 3600);
  await prisma.call.update({ where: { id: callId }, data: { providerData: { queueId: queue.id, queuedAt: new Date().toISOString() } } });
  emitToTenant(queue.tenantId, "floor:queue", { queueId: queue.id, callId, event: "join" });
  return [{ verb: "enqueue", name: `q-${queue.id}`, waitHook: hookUrl("/jambonz/queue-wait", { queueId: queue.id, callId }), actionHook: hookUrl("/jambonz/queue-exit", { queueId: queue.id, callId }) }];
}

/** Hold music between assignment checks. jambonz calls this when the previous verbs finish. */
export async function queueWaitVerbs(queueId: string): Promise<Verbs> {
  const q = await prisma.queue.findUnique({ where: { id: queueId } });
  const hold = await audio(q?.holdAudioId);
  return hold ? [{ verb: "play", url: hold }] : [{ verb: "pause", length: 15 }];
}

export async function leaveQueue(callId: string): Promise<void> {
  const raw = await redis.get(QMETA(callId));
  if (!raw) return;
  const meta = JSON.parse(raw) as { queueId: string; tenantId: string };
  await redis.zrem(QKEY(meta.queueId), callId);
  await redis.del(QMETA(callId));
  emitToTenant(meta.tenantId, "floor:queue", { queueId: meta.queueId, callId, event: "leave" });
}

/** Every second: hand waiting callers to qualified agents; overflow the ones who waited too long. */
export async function queueTick(): Promise<void> {
  const queues = await prisma.queue.findMany();
  for (const q of queues) {
    const waiting = await redis.zrange(QKEY(q.id), 0, -1, "WITHSCORES");
    if (waiting.length === 0) continue;
    const callers: Array<{ callId: string; at: number }> = [];
    for (let i = 0; i < waiting.length; i += 2) callers.push({ callId: waiting[i]!, at: Number(waiting[i + 1]) });
    for (const c of callers) {
      const call = await prisma.call.findUnique({ where: { id: c.callId } });
      if (!call?.providerCallId || call.endedAt) {
        await leaveQueue(c.callId);
        continue;
      }
      const waited = (Date.now() - c.at) / 1000;
      const agent = (await qualifiedAgents(q.tenantId, q))[0];
      if (agent) {
        await leaveQueue(c.callId);
        await claimAgent(agent, c.callId, call.leadId, { queue: q.name, waitedSeconds: Math.round(waited) });
        await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/bridge", { callId: c.callId, agentId: agent.userId }), method: "POST" }).catch((e) => log.warn({ err: e, callId: c.callId }, "queue bridge redirect failed"));
        continue;
      }
      if (waited > q.maxWaitSeconds) {
        await leaveQueue(c.callId);
        await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/overflow", { queueId: q.id, callId: c.callId }), method: "POST" }).catch((e) => log.warn({ err: e, callId: c.callId }, "queue overflow redirect failed"));
      }
    }
  }
}

export async function overflowVerbs(queueId: string, callId: string): Promise<Verbs> {
  const q = await prisma.queue.findUnique({ where: { id: queueId }, include: { voicemailBox: true } });
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!q || !call) return [{ verb: "hangup" }];
  if (q.overflowAction === "QUEUE" && q.overflowQueueId) {
    const next = await prisma.queue.findUnique({ where: { id: q.overflowQueueId } });
    if (next) return enqueueVerbs(next, callId);
  }
  if (q.overflowAction === "VOICEMAIL") {
    const box = q.voicemailBox ?? (await prisma.voicemailBox.upsert({ where: { tenantId_name: { tenantId: q.tenantId, name: `${q.name} voicemail` } }, create: { tenantId: q.tenantId, name: `${q.name} voicemail` }, update: {} }));
    if (!q.voicemailBoxId) await prisma.queue.update({ where: { id: q.id }, data: { voicemailBoxId: box.id } });
    return voicemailVerbs(box, callId, call.phone);
  }
  return [{ verb: "hangup" }];
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function routeInbound(callSid: string, fromRaw: string, toRaw: string): Promise<Verbs | null> {
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);
  if (!to) return null;
  const number = await prisma.callerIdNumber.findFirst({ where: { phone: to }, include: { campaign: true, ivr: true, queue: true } });
  if (!number) return null;
  const tenantId = number.tenantId;
  const lead = from ? await prisma.lead.findFirst({ where: { tenantId, phone: from }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }], include: { list: { select: { campaignId: true } } } }) : null;
  const campaignId = number.campaignId ?? number.queue?.campaignId ?? lead?.list.campaignId ?? null;
  const call = await prisma.call.create({ data: { tenantId, campaignId, leadId: lead?.id ?? null, direction: "INBOUND", phone: from ?? "unknown", callerId: to, providerCallId: callSid, answeredAt: new Date() } });
  await redis.set(`callsid:${callSid}`, call.id, "EX", 6 * 3600);
  if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "ANSWERED", data: { inbound: true, callId: call.id } } });
  const fromPhone = from ?? "unknown";

  switch (number.routeTo) {
    case "USER":
      return number.routeUserId ? ringUser(tenantId, number.routeUserId, call.id, fromPhone) : [{ verb: "hangup" }];
    case "IVR":
      return number.ivr ? ivrVerbs(number.ivr, call.id) : [{ verb: "hangup" }];
    case "QUEUE":
      return number.queue ? enqueueVerbs(number.queue, call.id) : [{ verb: "hangup" }];
    default: {
      // Campaign callback: owner first, then the campaign, then anyone.
      const free = (await listAgents(tenantId)).filter(isFree);
      const owner = lead?.ownerId ? free.find((a) => a.userId === lead.ownerId) : undefined;
      const onCampaign = campaignId ? free.filter((a) => a.campaignId === campaignId).sort((a, b) => a.since - b.since) : [];
      const agent = owner ?? onCampaign[0] ?? free.sort((a, b) => a.since - b.since)[0];
      if (agent) {
        await claimAgent(agent, call.id, lead?.id ?? null, { from: fromPhone });
        const verbs: Verbs = [];
        if (number.campaign?.disclosureOn) {
          const d = await audio(number.campaign.disclosureAudioId);
          if (d) verbs.push({ verb: "play", url: d });
        }
        return [...verbs, ...joinAgentVerbs(call.id, tenantId, agent.userId)];
      }
      if (lead && campaignId) {
        await prisma.callback.create({ data: { tenantId, campaignId, leadId: lead.id, agentId: lead.ownerId ?? null, scope: lead.ownerId ? "AGENT" : "CAMPAIGN", dueAt: new Date(), note: "Called in while nobody was free" } });
        await prisma.lead.update({ where: { id: lead.id }, data: { status: "CALLBACK", nextDialAt: new Date() } });
      }
      // Take a message in the campaign's box so nothing is lost.
      const box = campaignId
        ? await prisma.voicemailBox.upsert({ where: { tenantId_name: { tenantId, name: `${number.campaign?.name ?? "Campaign"} callbacks` } }, create: { tenantId, name: `${number.campaign?.name ?? "Campaign"} callbacks` }, update: {} })
        : null;
      await prisma.call.update({ where: { id: call.id }, data: { outcome: "NO_ANSWER", notes: "Inbound, no agent free" } });
      return box ? voicemailVerbs(box, call.id, fromPhone) : [{ verb: "hangup" }];
    }
  }
}
