// Placing a call to a lead, and what happens when it ends or is dispositioned.
import { onDispositioned, onDialed } from "../games";
import { chargeCallMinutes, outboundAllowed } from "../billing";
import { prisma, type Call, type Campaign, type Lead } from "@strowger/db";
import { toE164 } from "@strowger/shared/phone";
import { DID_RULES, capForNumber, hourlyCap } from "@strowger/shared/did-hygiene";
import { callerIdFallbackScope } from "@strowger/shared/did-plan";
import { stateForAreaCode } from "@strowger/shared";
import { config } from "../config";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { getAgent, patchAgent } from "../agents/state";
import { agentRoom, hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";
import { afterAttempt, daypartNow } from "./cadence";
import { removeInflight } from "./pacing";
import { enqueueWebhooks, type WebhookEvent } from "../webhooks/deliver";
import { leaveQueue, wrapAfterQueueCall } from "../inbound/queues";
import { queueCallbackEnded } from "../inbound/callbacks";
import { startSurveyInsteadOfHangup } from "../inbound/survey";
import { endLiveTransfersForCall } from "./transfers";
import { aiCallEnded } from "../inbound/ai/control";

const sidKey = (sid: string) => `callsid:${sid}`;

export async function callIdForSid(sid: string): Promise<string | null> {
  return redis.get(sidKey(sid));
}

/**
 * Choose the number to show the lead. Local presence first (same area code,
 * the campaign's own numbers and the shared pool), then the campaign's
 * fallback (`callerIdFallback`: any area code, the lead's state only, or
 * none); within that, the least-used today. A number is eligible only if
 * it is ACTIVE, registered (Free Caller Registry) when the rules require it,
 * not resting after a flag, under its daily cap for its age, and under the
 * per-hour spread. Caps are data in shared/did-hygiene. Nothing free: the
 * campaign's fixed caller ID if set, else null (the caller puts the lead back
 * for later).
 */
export async function pickCallerId(campaign: Campaign, leadPhone: string): Promise<string | null> {
  if (campaign.callerIdMode === "FIXED") return campaign.fixedCallerId;
  const now = new Date();
  const area = leadPhone.slice(0, 3);
  const base = {
    tenantId: campaign.tenantId,
    status: "ACTIVE" as const,
    OR: [{ campaignId: null }, { campaignId: campaign.id }],
    AND: [{ OR: [{ restUntil: null }, { restUntil: { lte: now } }] }, ...(DID_RULES.requireRegistration ? [{ registeredAt: { not: null } }] : [])],
  };
  const scope = callerIdFallbackScope(campaign.callerIdFallback, stateForAreaCode(area));
  const order = [{ usedToday: "asc" as const }, { lastUsedAt: "asc" as const }];
  const candidates = [
    ...(await prisma.callerIdNumber.findMany({ where: { ...base, areaCode: area }, orderBy: order, take: 10 })),
    ...(scope.kind === "none" ? [] : await prisma.callerIdNumber.findMany({ where: { ...base, areaCode: { not: area }, ...(scope.kind === "state" ? { state: scope.state } : {}) }, orderBy: order, take: 20 })),
  ];
  const hourKey = `did:hour:${now.toISOString().slice(0, 13)}`;
  for (const n of candidates) {
    const cap = capForNumber(n, now);
    if (n.usedToday >= cap) continue;
    const usedThisHour = Number((await redis.hget(hourKey, n.id)) ?? 0);
    if (usedThisHour >= hourlyCap(cap)) continue;
    await prisma.callerIdNumber.update({ where: { id: n.id }, data: { usedToday: { increment: 1 }, lastUsedAt: now, firstUsedAt: n.firstUsedAt ?? now } });
    await redis.hincrby(hourKey, n.id, 1);
    await redis.expire(hourKey, 2 * 3600);
    return n.phone;
  }
  const where = scope.kind === "none" ? `area code ${area} only` : scope.kind === "state" ? `area code ${area} or state ${scope.state}` : "any area code";
  const reason = candidates.length === 0 ? `no eligible caller ID (${where}): none in the campaign or pool, unregistered, or resting` : `no eligible caller ID (${where}): every number at its cap for now`;
  log.warn({ campaignId: campaign.id, area, fallback: campaign.callerIdFallback, usingFixed: Boolean(campaign.fixedCallerId) }, campaign.fixedCallerId ? `${reason}; using the fixed caller ID` : `${reason}; the lead waits`);
  return campaign.fixedCallerId;
}

export interface DialResult {
  ok: true;
  callId: string;
}
export interface DialError {
  ok: false;
  error: string;
}

/** Preview-mode dial: the agent is already reserved; the lead joins the agent's room on answer. */
export async function dialLeadForAgent(campaign: Campaign, lead: Lead, agentId: string, preferredCallerId?: string): Promise<DialResult | DialError> {
  if (!jambonzConfigured) return { ok: false, error: "Telephony is not configured (jambonz API key missing)" };
  const agent = await getAgent(agentId);
  if (!agent || !agent.agentCallSid) return { ok: false, error: "Your phone line is not up. Click Ready first." };

  const allowed = await outboundAllowed(campaign.tenantId);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  const callerId = preferredCallerId ?? (await pickCallerId(campaign, lead.phone));
  if (!callerId)
    return {
      ok: false,
      error:
        campaign.callerIdFallback === "EXACT_ONLY"
          ? `No caller ID in area code ${lead.phone.slice(0, 3)} is free right now (this campaign uses the exact area code only). Skip this lead for now.`
          : campaign.callerIdFallback === "SAME_STATE"
            ? "No caller ID in the lead's area code or state is free right now. Skip this lead for now."
            : "No caller ID number is available for this campaign",
    };

  const call = await prisma.call.create({
    data: {
      tenantId: campaign.tenantId,
      campaignId: campaign.id,
      leadId: lead.id,
      agentId,
      direction: "OUTBOUND",
      phone: lead.phone,
      callerId,
    },
  });

  const amd = campaign.amdEnabled
    ? {
        actionHook: hookUrl("/jambonz/amd", { callId: call.id }),
        timers: { decisionTimeoutMs: 6000, noSpeechTimeoutMs: 4000, greetingCompletionTimeoutMs: 1500 },
      }
    : undefined;

  try {
    type CreateReq = Parameters<typeof jambonz.calls.create>[0];
    const req = {
      from: toE164(callerId),
      to: { type: "phone", number: toE164(lead.phone) },
      ...(config.JAMBONZ_CARRIER ? { trunk: config.JAMBONZ_CARRIER } : {}),
      ...(config.JAMBONZ_APPLICATION_SID
        ? { application_sid: config.JAMBONZ_APPLICATION_SID }
        : { call_hook: { url: hookUrl("/jambonz/call"), method: "post" as const }, call_status_hook: { url: hookUrl("/jambonz/status"), method: "post" as const } }),
      timeout: 30,
      tag: { kind: "lead", callId: call.id, agentId, campaignId: campaign.id, tenantId: campaign.tenantId },
      ...(amd ? { amd } : {}),
    } as CreateReq;
    const sid = await jambonz.calls.create(req);
    await redis.set(sidKey(sid), call.id, "EX", 6 * 3600);
    void onDialed(campaign.tenantId, campaign.id, agentId);
    await prisma.call.update({ where: { id: call.id }, data: { providerCallId: sid } });
    const cadence = await prisma.list.findUnique({ where: { id: lead.listId }, select: { cadence: { select: { dayparts: true } } } });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { attemptsTotal: { increment: 1 }, lastAttemptAt: new Date(), assignedCallerId: callerId, lastAttemptDaypart: daypartNow(lead.timezone, cadence?.cadence?.dayparts) },
    });
    await prisma.leadEvent.create({ data: { tenantId: campaign.tenantId, leadId: lead.id, kind: "DIAL", actorId: agentId, data: { callId: call.id, callerId } } });
    await patchAgent(agentId, { state: "ON_CALL", currentCallId: call.id, reservedLeadId: null });
    emitToAgent(agentId, "call:update", { callId: call.id, status: "dialing", leadId: lead.id });
    return { ok: true, callId: call.id };
  } catch (e) {
    log.error({ err: e, callId: call.id }, "jambonz create call failed");
    await prisma.call.update({ where: { id: call.id }, data: { outcome: "FAILED", endedAt: new Date(), providerData: { error: String(e) } } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "NEW", ownerId: null, nextDialAt: new Date(Date.now() + 15 * 60_000) } });
    return { ok: false, error: `Could not place the call: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function hangupCall(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call?.providerCallId || call.endedAt) return;
  // An inbound queue call with the post-call survey on: the caller goes to the survey instead of being hung up.
  if (await startSurveyInsteadOfHangup(callId).catch(() => false)) return;
  await jambonz.calls.update(call.providerCallId, { call_status: "completed" }).catch((e) => log.warn({ err: e, callId }, "hangup failed"));
}

/** The lead leg ended, from the status hook. Moves the agent to wrap-up. */
export async function leadCallEnded(callId: string, status: string, sipStatus: number | undefined, duration: number | undefined): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: { include: { dialPlans: true } }, lead: true } });
  if (!call || call.endedAt) return;
  const outcome =
    call.outcome ??
    (call.bridgedAt
      ? "BRIDGED"
      : status === "busy"
        ? "BUSY"
        : status === "no-answer"
          ? "NO_ANSWER"
          : status === "failed"
            ? "FAILED"
            : call.answeredAt
              ? "BRIDGED"
              : "NO_ANSWER");
  await prisma.call.update({
    where: { id: callId },
    data: { endedAt: new Date(), outcome, providerData: { ...(call.providerData as object), finalStatus: status, sipStatus: sipStatus ?? null, duration: duration ?? null } },
  });
  if (call.campaignId) await removeInflight(call.campaignId, callId);
  await leaveQueue(callId, "hangup").catch(() => undefined);
  // The caller hung up on the AI answer: its part of the call is finished (outcome, transcript, minutes).
  await aiCallEnded(callId).catch((e) => log.warn({ err: e, callId }, "finishing the AI part failed"));
  // A destination still ringing or in the three-way has nobody to talk to now.
  await endLiveTransfersForCall(callId).catch((e) => log.warn({ err: e, callId }, "ending transfers after the lead left failed"));
  void chargeCallMinutes(callId).catch((e) => log.warn({ err: e, callId }, "billing: minutes charge failed"));
  // Short calls (hangups, voicemail drops, abandons) are what carrier analytics punish: count them per number.
  const talk = call.answeredAt ? (Date.now() - call.answeredAt.getTime()) / 1000 : 0;
  if (call.callerId && call.answeredAt && talk < DID_RULES.shortCallSeconds) {
    await prisma.callerIdNumber.updateMany({ where: { tenantId: call.tenantId, phone: call.callerId }, data: { shortCallsToday: { increment: 1 } } }).catch(() => undefined);
  }

  if (call.lead && call.campaign) {
    // Default recycle from the dial plan; the disposition may override it.
    const age = Math.floor((Date.now() - call.lead.postedAt.getTime()) / 86_400_000);
    const plan = call.campaign.dialPlans.find((p) => p.active && (p.leadType === null || p.leadType === call.lead!.leadType) && age >= p.ageFromDays && (p.ageToDays === null || age <= p.ageToDays));
    const voicemail = outcome === "VOICEMAIL" || outcome === "VOICEMAIL_DROPPED";
    const gap = voicemail ? call.campaign.voicemailRetryMinutes : (plan?.retryGapMinutes ?? 180);
    if (call.lead.status === "DIALING") {
      await prisma.lead.update({ where: { id: call.lead.id }, data: { status: call.bridgedAt ? "CONTACTED" : "NEW", nextDialAt: new Date(Date.now() + gap * 60_000) } });
    }
    // Cadence follow-up: missed-call text, next slot by gap and daypart; or cancel the day's redials.
    afterAttempt(call.lead.id, Boolean(call.bridgedAt), call.campaign).catch((e) => log.warn({ err: e, callId }, "cadence afterAttempt failed"));
  }

  // After an external transfer the agent left this call long ago (wrap-up, or on a new call): an "ended" now must not touch their screen.
  const agentLeft = Boolean(await prisma.transfer.findFirst({ where: { callId, agentLeftAt: { not: null } }, select: { id: true } }));
  if (call.agentId && !agentLeft) {
    const agent = await getAgent(call.agentId);
    if (agent && agent.currentCallId === callId) {
      // Inbound queue calls (and queue callbacks) wrap up on the queue's timer.
      if (call.queueId) await wrapAfterQueueCall(call);
      else await patchAgent(call.agentId, { state: "WRAP_UP" });
    }
    emitToAgent(call.agentId, "call:update", { callId, status: "ended", outcome });
  }
  emitToTenant(call.tenantId, "floor:call", { callId, status: "ended", outcome, transferred: agentLeft });
  // A queue callback that never connected goes back in line (or gives up); one that did is done.
  await queueCallbackEnded(callId, Boolean(call.bridgedAt)).catch((e) => log.warn({ err: e, callId }, "queue callback end failed"));
}

/**
 * The screener flag as the console wants it on every call:update once a
 * phone's call screener was heard on the lead leg (jambonz/routes transcript
 * hook). The console shows the SCREENER banner and the script from this.
 */
export function screenerFields(call: Pick<Call, "screenerDetected" | "providerData">): { screener: true; screenerPhrase: string | null } | Record<string, never> {
  if (!call.screenerDetected) return {};
  const phrase = (call.providerData as { screenerPhrase?: unknown }).screenerPhrase;
  return { screener: true, screenerPhrase: typeof phrase === "string" ? phrase : null };
}

/** The lifecycle word the console keys on, from the call's timestamps. */
export function callStatusOf(call: Pick<Call, "endedAt" | "bridgedAt" | "answeredAt">): "ended" | "bridged" | "answered" | "dialing" {
  return call.endedAt ? "ended" : call.bridgedAt ? "bridged" : call.answeredAt ? "answered" : "dialing";
}

export async function leadCallAnswered(callId: string): Promise<void> {
  const call = await prisma.call.update({ where: { id: callId }, data: { answeredAt: new Date() } });
  if (call.agentId) emitToAgent(call.agentId, "call:update", { callId, status: "answered", ...screenerFields(call) });
}

export async function leadCallBridged(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || call.bridgedAt) return;
  await prisma.call.update({ where: { id: callId }, data: { bridgedAt: new Date() } });
  if (call.agentId) emitToAgent(call.agentId, "call:update", { callId, status: "bridged", ...screenerFields(call) });
}

export interface DispositionInput {
  callId: string;
  /**
   * Omit for a callback: the campaign's `isCallback` disposition is used, and
   * a default "Callback" (code CB) is created on the campaign if it has none.
   */
  dispositionId?: string | null;
  notes?: string | null;
  callbackAt?: string | null;
  callbackScope?: "AGENT" | "CAMPAIGN";
  actorId: string;
  /**
   * Write the disposition but leave the agent in WRAP_UP on this call so they
   * can change it (the auto "Transferred" disposition when they leave a
   * transferred call). Default: the agent goes back to READY.
   */
  keepWrapUp?: boolean;
}

/** The campaign's callback disposition, created as "Callback" (CB) when the campaign has none. */
async function callbackDisposition(campaignId: string, tenantId: string) {
  const existing = await prisma.disposition.findFirst({ where: { campaignId, isCallback: true, active: true }, orderBy: { sortOrder: "asc" } });
  if (existing) return existing;
  return prisma.disposition.upsert({
    where: { campaignId_code: { campaignId, code: "CB" } },
    update: { isCallback: true, active: true },
    create: { tenantId, campaignId, code: "CB", label: "Callback", isContact: true, isCallback: true, sortOrder: 999 },
  });
}

export async function dispositionCall(input: DispositionInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const call = await prisma.call.findUnique({ where: { id: input.callId }, include: { lead: true, campaign: true } });
  if (!call || !call.campaign) return { ok: false, error: "Unknown call" };
  const disp = input.dispositionId ? await prisma.disposition.findFirst({ where: { id: input.dispositionId, campaignId: call.campaign.id } }) : await callbackDisposition(call.campaign.id, call.tenantId);
  if (!disp) return { ok: false, error: "Unknown disposition" };

  const now = new Date();
  await prisma.call.update({ where: { id: call.id }, data: { dispositionId: disp.id, notes: input.notes ?? null, ...(input.keepWrapUp || call.wrapEndedAt ? {} : { wrapEndedAt: now }) } });

  if (call.lead) {
    let status: "CONTACTED" | "FINISHED" | "DNC" | "CALLBACK" | "NEW" = disp.isContact ? "CONTACTED" : "NEW";
    let nextDialAt: Date | null = disp.recycleAfterMinutes ? new Date(now.getTime() + disp.recycleAfterMinutes * 60_000) : null;
    if (disp.recycleAfterMinutes === null && !disp.isCallback) status = "FINISHED";
    if (disp.isDnc) {
      status = "DNC";
      nextDialAt = null;
      await prisma.dncEntry.createMany({ data: [{ tenantId: call.tenantId, phone: call.lead.phone, scope: "SYSTEM", source: "DISPOSITION", note: `Agent disposition ${disp.code}` }], skipDuplicates: true });
      await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.lead.id, kind: "DNC", actorId: input.actorId, data: { callId: call.id } } });
    }
    if (disp.isCallback) {
      const dueAt = input.callbackAt ? new Date(input.callbackAt) : new Date(now.getTime() + 60 * 60_000);
      status = "CALLBACK";
      nextDialAt = dueAt;
      await prisma.callback.create({
        data: { tenantId: call.tenantId, campaignId: call.campaign.id, leadId: call.lead.id, agentId: input.actorId, scope: input.callbackScope ?? "AGENT", dueAt, note: input.notes ?? null },
      });
      await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.lead.id, kind: "CALLBACK_SET", actorId: input.actorId, data: { dueAt } } });
    }
    await prisma.lead.update({
      where: { id: call.lead.id },
      data: { status, nextDialAt, ownerId: disp.isCallback ? input.actorId : null, lastAgentId: input.actorId, scrubStatus: disp.isDnc ? "DNC" : undefined },
    });
    await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.lead.id, kind: "DISPOSITION", actorId: input.actorId, data: { callId: call.id, code: disp.code, notes: input.notes ?? null } } });
  }

  const agent = await getAgent(input.actorId);
  if (agent && agent.currentCallId === call.id) {
    if (input.keepWrapUp) await patchAgent(input.actorId, { state: "WRAP_UP" });
    else {
      // Back to Ready only when the agent was Ready before the call. A call they dialled by hand (from Paused, or
      // from Ready, which pauses them) returns them to Paused, so the dialer never starts calling behind them.
      const paused = agent.afterCall === "PAUSED" || !agent.agentCallSid;
      await patchAgent(input.actorId, { currentCallId: null, afterCall: null, wrapUntil: null, state: paused ? "PAUSED" : "READY", pauseReason: paused ? (agent.agentCallSid ? (agent.pauseReason ?? "Manual dial") : "Line dropped") : null });
    }
  }
  emitToTenant(call.tenantId, "floor:call", { callId: call.id, status: "dispositioned", code: disp.code });
  void onDispositioned(call.tenantId, call.campaign.id, input.actorId, call.id, { isSale: disp.isSale, isContact: disp.isContact, code: disp.code });

  // CRM push: one delivery per endpoint that subscribes to any of these events.
  const events: WebhookEvent[] = ["disposition", ...(disp.isSale ? (["sale"] as const) : []), ...(disp.isCallback ? (["callback"] as const) : []), ...(disp.isDnc ? (["dnc"] as const) : [])];
  const agentUser = await prisma.user.findUnique({ where: { id: input.actorId }, select: { email: true, firstName: true, lastName: true } });
  await enqueueWebhooks(call.tenantId, call.campaign.id, events, {
    call: { id: call.id, direction: call.direction, phone: call.phone, caller_id: call.callerId, dialed_at: call.dialedAt, answered_at: call.answeredAt, bridged_at: call.bridgedAt, ended_at: call.endedAt, outcome: call.outcome, recording_url: call.recordingUrl },
    disposition: { code: disp.code, label: disp.label, is_sale: disp.isSale, is_contact: disp.isContact, is_callback: disp.isCallback, is_dnc: disp.isDnc, notes: input.notes ?? null, callback_at: input.callbackAt ?? null },
    agent: agentUser ? { id: input.actorId, email: agentUser.email, name: [agentUser.firstName, agentUser.lastName].filter(Boolean).join(" ") } : { id: input.actorId },
    campaign: { id: call.campaign.id, name: call.campaign.name },
    lead: call.lead
      ? { id: call.lead.id, phone: call.lead.phone, first_name: call.lead.firstName, last_name: call.lead.lastName, email: call.lead.email, address: call.lead.address, city: call.lead.city, state: call.lead.state, zip: call.lead.zip, lead_type: call.lead.leadType, list_id: call.lead.listId, custom: call.lead.custom, jornaya_lead_id: call.lead.consentJornayaId, trustedform_cert_url: call.lead.consentTrustedFormId }
      : null,
  }).catch((e) => log.warn({ err: e, callId: call.id }, "webhook enqueue failed"));
  return { ok: true };
}

export { agentRoom };
