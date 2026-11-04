// Placing a call to a lead, and what happens when it ends or is dispositioned.
import { prisma, type Campaign, type Lead } from "@strowger/db";
import { toE164 } from "@strowger/shared/phone";
import { config } from "../config";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { getAgent, patchAgent } from "../agents/state";
import { agentRoom, hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";

const sidKey = (sid: string) => `callsid:${sid}`;

export async function callIdForSid(sid: string): Promise<string | null> {
  return redis.get(sidKey(sid));
}

/** Choose the number to show the lead. Local presence first, then any active, then the campaign's fixed number. */
export async function pickCallerId(campaign: Campaign, leadPhone: string): Promise<string | null> {
  if (campaign.callerIdMode === "FIXED") return campaign.fixedCallerId;
  const area = leadPhone.slice(0, 3);
  const same = await prisma.callerIdNumber.findFirst({
    where: { tenantId: campaign.tenantId, status: "ACTIVE", areaCode: area },
    orderBy: [{ usedToday: "asc" }, { lastUsedAt: "asc" }],
  });
  const pick =
    same ??
    (await prisma.callerIdNumber.findFirst({
      where: { tenantId: campaign.tenantId, status: "ACTIVE" },
      orderBy: [{ usedToday: "asc" }, { lastUsedAt: "asc" }],
    }));
  if (pick) {
    await prisma.callerIdNumber.update({ where: { id: pick.id }, data: { usedToday: { increment: 1 }, lastUsedAt: new Date() } });
    return pick.phone;
  }
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
export async function dialLeadForAgent(campaign: Campaign, lead: Lead, agentId: string): Promise<DialResult | DialError> {
  if (!jambonzConfigured) return { ok: false, error: "Telephony is not configured (jambonz API key missing)" };
  const agent = await getAgent(agentId);
  if (!agent || !agent.agentCallSid) return { ok: false, error: "Your phone line is not up. Click Ready first." };

  const callerId = await pickCallerId(campaign, lead.phone);
  if (!callerId) return { ok: false, error: "No caller ID number is available for this campaign" };

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
    await prisma.call.update({ where: { id: call.id }, data: { providerCallId: sid } });
    await prisma.lead.update({ where: { id: lead.id }, data: { attemptsTotal: { increment: 1 }, lastAttemptAt: new Date() } });
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

  if (call.lead && call.campaign) {
    // Default recycle from the dial plan; the disposition may override it.
    const age = Math.floor((Date.now() - call.lead.postedAt.getTime()) / 86_400_000);
    const plan = call.campaign.dialPlans.find((p) => p.active && (p.leadType === null || p.leadType === call.lead!.leadType) && age >= p.ageFromDays && (p.ageToDays === null || age <= p.ageToDays));
    const gap = plan?.retryGapMinutes ?? 180;
    if (call.lead.status === "DIALING") {
      await prisma.lead.update({ where: { id: call.lead.id }, data: { status: call.bridgedAt ? "CONTACTED" : "NEW", nextDialAt: new Date(Date.now() + gap * 60_000) } });
    }
  }

  if (call.agentId) {
    const agent = await getAgent(call.agentId);
    if (agent && agent.currentCallId === callId) {
      await patchAgent(call.agentId, { state: agent.agentCallSid ? "WRAP_UP" : "LOGGED_IN" });
    }
    emitToAgent(call.agentId, "call:update", { callId, status: "ended", outcome });
  }
  emitToTenant(call.tenantId, "floor:call", { callId, status: "ended", outcome });
}

export async function leadCallAnswered(callId: string): Promise<void> {
  const call = await prisma.call.update({ where: { id: callId }, data: { answeredAt: new Date() } });
  if (call.agentId) emitToAgent(call.agentId, "call:update", { callId, status: "answered" });
}

export async function leadCallBridged(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || call.bridgedAt) return;
  await prisma.call.update({ where: { id: callId }, data: { bridgedAt: new Date() } });
  if (call.agentId) emitToAgent(call.agentId, "call:update", { callId, status: "bridged" });
}

export interface DispositionInput {
  callId: string;
  dispositionId: string;
  notes?: string | null;
  callbackAt?: string | null;
  callbackScope?: "AGENT" | "CAMPAIGN";
  actorId: string;
}

export async function dispositionCall(input: DispositionInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const call = await prisma.call.findUnique({ where: { id: input.callId }, include: { lead: true, campaign: true } });
  if (!call || !call.campaign) return { ok: false, error: "Unknown call" };
  const disp = await prisma.disposition.findFirst({ where: { id: input.dispositionId, campaignId: call.campaign.id } });
  if (!disp) return { ok: false, error: "Unknown disposition" };

  const now = new Date();
  await prisma.call.update({ where: { id: call.id }, data: { dispositionId: disp.id, notes: input.notes ?? null } });

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
      data: { status, nextDialAt, ownerId: disp.isCallback ? input.actorId : null, scrubStatus: disp.isDnc ? "DNC" : undefined },
    });
    await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.lead.id, kind: "DISPOSITION", actorId: input.actorId, data: { callId: call.id, code: disp.code, notes: input.notes ?? null } } });
  }

  const agent = await getAgent(input.actorId);
  if (agent && agent.currentCallId === call.id) {
    await patchAgent(input.actorId, { currentCallId: null, state: agent.agentCallSid ? "READY" : "LOGGED_IN" });
  }
  emitToTenant(call.tenantId, "floor:call", { callId: call.id, status: "dispositioned", code: disp.code });
  return { ok: true };
}

export { agentRoom };
