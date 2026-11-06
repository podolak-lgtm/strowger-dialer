// Queue callbacks (virtual hold). A caller who pressed 1 left the line but
// kept their place: `cb:<id>` in the queue's sorted set at their old score.
// When the queue tick reaches them and an agent is free, the agent is
// reserved, the caller is dialled from the number they called, and the
// answer joins the agent's room. Calling hours apply (the caller's zone, the
// queue's campaign window if it has one); DNC does not, they asked for this
// call. Two attempts, then a note in the queue's voicemail box.
import { prisma, type Call, type Queue, type QueueCallback } from "@strowger/db";
import { evaluateDialWindow, parseAllowedHours } from "@strowger/shared/compliance";
import { resolveZone } from "@strowger/shared/geo";
import { toE164 } from "@strowger/shared/phone";
import { getAgent, patchAgent, type AgentLive } from "../agents/state";
import { outboundAllowed } from "../billing";
import { config } from "../config";
import { hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { boxForQueue, joinAgentVerbs, type Verbs } from "./common";
import { recordAnswer, removeCallbackMember, requeueCallback } from "./queues";

export const QUEUE_CALLBACK_MAX_ATTEMPTS = 2;
const NOT_NOW = (id: string) => `qcbwait:${id}`;

/** True when the call was placed and the agent reserved. */
export async function placeQueueCallback(q: Queue, cb: QueueCallback, agent: AgentLive): Promise<boolean> {
  if (!jambonzConfigured) return false;
  if (await redis.get(NOT_NOW(cb.id))) return false;
  const lead = cb.leadId ? await prisma.lead.findUnique({ where: { id: cb.leadId } }) : null;
  const campaign = q.campaignId ? await prisma.campaign.findUnique({ where: { id: q.campaignId } }) : null;
  const zone = resolveZone({ phone: cb.phone, state: lead?.state ?? null, zip: lead?.zip ?? null });
  const window = evaluateDialWindow({
    timezone: lead?.timezone ?? zone?.timezone ?? null,
    state: lead?.state ?? zone?.state ?? null,
    campaignStartHour: campaign?.localWindowStart ?? 8,
    campaignEndHour: campaign?.localWindowEnd ?? 21,
    allowedHours: campaign ? parseAllowedHours(campaign.allowedHours) : null,
    attemptsAllowedPerDay: 99,
    attemptsToday: 0,
  });
  if (!window.allowed) {
    // Outside the caller's calling hours: look again in ten minutes, keep the place.
    await redis.set(NOT_NOW(cb.id), window.reason, "EX", 600);
    log.info({ queueCallbackId: cb.id, reason: window.reason }, "queue callback waits for calling hours");
    return false;
  }
  if (!(await outboundAllowed(q.tenantId)).ok) return false;
  if (!cb.callerId) {
    await finishCallback(cb, "FAILED", q, "No number to call back from");
    return false;
  }
  const claimed = await prisma.queueCallback.updateMany({ where: { id: cb.id, status: "WAITING" }, data: { status: "DIALING", attempts: { increment: 1 }, lastAttemptAt: new Date(), agentId: agent.userId } });
  if (claimed.count !== 1) return false;
  await removeCallbackMember(cb);

  const call = await prisma.call.create({
    data: { tenantId: q.tenantId, campaignId: q.campaignId, leadId: cb.leadId, agentId: agent.userId, direction: "OUTBOUND", phone: cb.phone, callerId: cb.callerId, queueId: q.id, queuedAt: cb.requestedAt, providerData: { queueCallbackId: cb.id, attempt: cb.attempts + 1 } },
  });
  await prisma.queueCallback.update({ where: { id: cb.id }, data: { callId: call.id } });
  await patchAgent(agent.userId, { state: "ON_CALL", currentCallId: call.id, reservedLeadId: null, wrapUntil: null });
  emitToAgent(agent.userId, "call:update", { callId: call.id, status: "dialing", leadId: cb.leadId, queueCallback: q.name, from: cb.phone });
  try {
    type CreateReq = Parameters<typeof jambonz.calls.create>[0];
    const req = {
      from: toE164(cb.callerId),
      to: { type: "phone", number: toE164(cb.phone) },
      ...(config.JAMBONZ_CARRIER ? { trunk: config.JAMBONZ_CARRIER } : {}),
      ...(config.JAMBONZ_APPLICATION_SID
        ? { application_sid: config.JAMBONZ_APPLICATION_SID }
        : { call_hook: { url: hookUrl("/jambonz/call"), method: "post" as const }, call_status_hook: { url: hookUrl("/jambonz/status"), method: "post" as const } }),
      timeout: 30,
      tag: { kind: "qcallback", callId: call.id, queueCallbackId: cb.id, agentId: agent.userId, tenantId: q.tenantId },
    } as CreateReq;
    const sid = await jambonz.calls.create(req);
    await redis.set(`callsid:${sid}`, call.id, "EX", 6 * 3600);
    await prisma.call.update({ where: { id: call.id }, data: { providerCallId: sid } });
    log.info({ queueCallbackId: cb.id, callId: call.id, agentId: agent.userId, attempt: cb.attempts + 1 }, "queue callback dialled");
    emitToTenant(q.tenantId, "floor:call", { callId: call.id, status: "queue-callback", agentId: agent.userId });
    return true;
  } catch (e) {
    log.error({ err: e, queueCallbackId: cb.id }, "queue callback: create call failed");
    await prisma.call.update({ where: { id: call.id }, data: { outcome: "FAILED", endedAt: new Date(), providerData: { queueCallbackId: cb.id, error: String(e) } } });
    await queueCallbackEnded(call.id, false);
    return true; // the agent was touched; queueCallbackEnded put them back
  }
}

/** The callback leg answered: straight into the reserved agent's room. */
export async function queueCallbackAnswered(callId: string): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: { select: { name: true } } } });
  if (!call?.agentId) return [{ verb: "hangup" }];
  await prisma.call.update({ where: { id: callId }, data: { answeredAt: call.answeredAt ?? new Date() } });
  const agent = await getAgent(call.agentId);
  if (!agent?.agentCallSid || agent.currentCallId !== callId) {
    log.warn({ callId }, "queue callback answered but the agent is gone");
    await queueCallbackEnded(callId, false);
    return [{ verb: "hangup" }];
  }
  emitToAgent(call.agentId, "call:update", { callId, status: "answered", leadId: call.leadId, inbound: true, queueCallback: call.queue?.name ?? "queue", from: call.phone });
  return joinAgentVerbs(callId, call.tenantId, call.agentId);
}

/** The callback leg ended (from leadCallEnded): done when it bridged, else retry once at the same place, then give up. */
export async function queueCallbackEnded(callId: string, bridged: boolean): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  const cbId = (call?.providerData as { queueCallbackId?: string } | null)?.queueCallbackId;
  if (!call || !cbId) return;
  const cb = await prisma.queueCallback.findUnique({ where: { id: cbId }, include: { queue: true } });
  if (!cb || cb.callId !== callId || cb.status !== "DIALING") return;
  if (bridged) {
    await prisma.queueCallback.update({ where: { id: cb.id }, data: { status: "DONE", doneAt: new Date() } });
    const waited = Math.round(((call.bridgedAt ?? new Date()).getTime() - cb.requestedAt.getTime()) / 1000);
    await prisma.call.update({ where: { id: callId }, data: { waitSeconds: waited } });
    if (call.agentId) await recordAnswer(cb.queueId, callId, waited, call.agentId);
    return;
  }
  // Never connected: the reserved agent goes straight back to Ready.
  if (call.agentId) {
    const a = await getAgent(call.agentId);
    if (a && a.currentCallId === callId) await patchAgent(call.agentId, { state: a.agentCallSid ? "READY" : "PAUSED", currentCallId: null, wrapUntil: null, ...(a.agentCallSid ? { pauseReason: null } : { pauseReason: "Line dropped" }) });
    emitToAgent(call.agentId, "call:update", { callId, status: "wrapped" });
  }
  if (cb.attempts < QUEUE_CALLBACK_MAX_ATTEMPTS) {
    const back = await prisma.queueCallback.update({ where: { id: cb.id }, data: { status: "WAITING", agentId: null } });
    // A short breather before the second try so the same no-answer is not redialled at once.
    await redis.set(NOT_NOW(cb.id), "retry", "EX", 120);
    await requeueCallback(back);
    log.info({ queueCallbackId: cb.id, attempts: cb.attempts }, "queue callback not answered; back in line");
    return;
  }
  await finishCallback(cb, "FAILED", cb.queue, `No answer after ${cb.attempts} callback attempts`);
}

async function finishCallback(cb: QueueCallback, status: "FAILED" | "DONE", q: Queue, note: string): Promise<void> {
  await prisma.queueCallback.update({ where: { id: cb.id }, data: { status, doneAt: new Date() } });
  await removeCallbackMember(cb);
  // A note in the queue's box so someone follows up by hand.
  const box = await boxForQueue(q);
  await prisma.voicemail.create({ data: { tenantId: q.tenantId, boxId: box.id, callId: cb.originalCallId, fromPhone: cb.phone, assigneeId: box.ownerId, transcript: `Queue callback (${q.name}): ${note}. Call them back.` } });
  if (box.ownerId) emitToAgent(box.ownerId, "voicemail:new", { boxId: box.id, fromPhone: cb.phone, queueCallback: true });
  log.warn({ queueCallbackId: cb.id, note }, "queue callback given up; note left in the queue's voicemail box");
}

export function isQueueCallback(call: Pick<Call, "providerData">): boolean {
  return Boolean((call.providerData as { queueCallbackId?: string } | null)?.queueCallbackId);
}
