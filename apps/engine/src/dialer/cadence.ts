// Cadence execution: what happens when a lead is posted into a list with a
// cadence, and what happens after each attempt.
import { prisma, type CadenceProfile, type Campaign, type Lead } from "@strowger/db";
import { daypartOf, localParts, nextAttemptAt, parseDayparts, prettyPhone, renderTemplate, type Daypart } from "@strowger/shared/cadence";
import { evaluateDialWindow } from "@strowger/shared/compliance";
import { randomBytes } from "node:crypto";
import { listAgents, patchAgent } from "../agents/state";
import { config } from "../config";
import { log } from "../log";
import { sendSms } from "../sms/provider";
import { dialLeadForAgent, pickCallerId } from "./calls";

const timers = new Map<string, NodeJS.Timeout>();

function vars(lead: Lead, callerId: string | null) {
  return {
    first_name: lead.firstName ?? "there",
    last_name: lead.lastName ?? "",
    caller_id_number: callerId ? prettyPhone(callerId) : "",
    quick_callback_link: lead.callbackToken ? `${config.WEB_PUBLIC_URL}/cb/${lead.callbackToken}` : "",
  };
}

/**
 * Texts obey the same quiet hours as calls (federal 8–9, state rules such as
 * Florida's 8–8 cover texts too). Attempt caps are not applied to texts.
 */
function textingAllowed(lead: Lead, campaign: Campaign): boolean {
  const d = evaluateDialWindow({
    timezone: lead.timezone,
    state: lead.state,
    campaignStartHour: campaign.localWindowStart,
    campaignEndHour: campaign.localWindowEnd,
    allowedHours: campaign.allowedHours as number[][] | null,
    attemptsAllowedPerDay: 999,
    attemptsToday: 0,
  });
  if (!d.allowed) log.info({ leadId: lead.id, reason: d.reason }, "text suppressed: outside window");
  return d.allowed;
}

async function ensureCallbackToken(lead: Lead): Promise<Lead> {
  if (lead.callbackToken) return lead;
  return prisma.lead.update({ where: { id: lead.id }, data: { callbackToken: randomBytes(12).toString("base64url") } });
}

/** A READY fronter on the campaign with nothing reserved, or null. */
async function readyAgentFor(campaign: Campaign): Promise<string | null> {
  const live = (await listAgents(campaign.tenantId)).filter((a) => a.campaignId === campaign.id && a.state === "READY" && a.agentCallSid && !a.reservedLeadId && !a.currentCallId);
  if (live.length === 0) return null;
  const assignments = await prisma.campaignAgent.findMany({ where: { campaignId: campaign.id, userId: { in: live.map((a) => a.userId) } } });
  const ok = live.filter((a) => {
    const ca = assignments.find((x) => x.userId === a.userId);
    return !ca || ca.agentMode !== "CLOSER" || (campaign.closersMayDial && ca.outboundOn);
  });
  // Longest-idle first.
  ok.sort((a, b) => a.since - b.since);
  return ok[0]?.userId ?? null;
}

/**
 * lead.created: a posted lead landed in a list. FRESH + instantDial and an
 * agent is Ready: text from the dialing number, wait the configured few
 * seconds, dial into that agent. Otherwise the lead goes to the front of its
 * priority tier and the same pair runs when an agent is next Ready.
 */
export async function onLeadPosted(leadId: string): Promise<{ action: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { list: { include: { cadence: true, campaign: true } } } });
  if (!lead || lead.status !== "NEW") return { action: "ignored" };
  const cadence = lead.list.cadence;
  const campaign = lead.list.campaign;
  if (!cadence || cadence.kind !== "FRESH" || !cadence.instantDial || !campaign || campaign.status !== "ACTIVE") {
    await prisma.lead.update({ where: { id: leadId }, data: { nextDialAt: new Date() } });
    return { action: "queued" };
  }
  const agentId = await readyAgentFor(campaign);
  if (!agentId) {
    await prisma.lead.update({ where: { id: leadId }, data: { nextDialAt: new Date() } });
    return { action: "queued_no_agent" };
  }
  return runFreshCadence(lead, cadence, campaign, agentId);
}

/** Reserve the agent, text, dial. Shared by the post trigger and the hopper. */
export async function runFreshCadence(lead: Lead, cadence: CadenceProfile, campaign: Campaign, agentId: string): Promise<{ action: string }> {
  const reserved = await prisma.lead.updateMany({ where: { id: lead.id, status: { in: ["NEW", "CONTACTED", "CALLBACK"] } }, data: { status: "DIALING", ownerId: agentId } });
  if (reserved.count !== 1) return { action: "lost_race" };
  await patchAgent(agentId, { reservedLeadId: lead.id });

  const callerId = lead.assignedCallerId ?? (await pickCallerId(campaign, lead.phone));
  let fresh = await prisma.lead.update({ where: { id: lead.id }, data: { assignedCallerId: callerId } });
  if (cadence.preCallSms && callerId && textingAllowed(fresh, campaign)) {
    fresh = await ensureCallbackToken(fresh);
    await sendSms({ tenantId: campaign.tenantId, campaignId: campaign.id, leadId: fresh.id, from: callerId, to: fresh.phone, body: renderTemplate(cadence.preCallSms, vars(fresh, callerId)), purpose: "pre_call" });
  }
  const delay = Math.max(0, Math.min(10, cadence.instantDelaySeconds)) * 1000;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, delay);
    timers.set(fresh.id, t);
  });
  timers.delete(fresh.id);
  const current = await prisma.lead.findUnique({ where: { id: fresh.id } });
  if (!current || current.status !== "DIALING" || current.ownerId !== agentId) return { action: "cancelled" };
  const r = await dialLeadForAgent(campaign, current, agentId, callerId ?? undefined);
  if (!r.ok) {
    log.warn({ leadId: lead.id, error: r.error }, "fresh cadence dial failed");
    await patchAgent(agentId, { reservedLeadId: null });
    await prisma.lead.updateMany({ where: { id: lead.id, status: "DIALING" }, data: { status: "NEW", ownerId: null, nextDialAt: new Date(Date.now() + 15 * 60_000) } });
    return { action: `dial_failed: ${r.error}` };
  }
  return { action: "dialed" };
}

/** Record the daypart of an attempt at dial time. */
export function daypartNow(zone: string | null, windows: unknown): Daypart | null {
  if (!zone) return null;
  const p = localParts(zone, new Date());
  return p ? daypartOf(p.hourFrac, parseDayparts(windows)) : null;
}

/**
 * After a lead call ends. Answered + cancelRedialsOnAnswer: no more automated
 * attempts today. Missed: text the callback link, schedule the next attempt by
 * the cadence (gap, daypart rotation, daily cap).
 */
export async function afterAttempt(leadId: string, answered: boolean, campaign: Campaign): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { list: { include: { cadence: true } } } });
  if (!lead) return;
  const cadence = lead.list.cadence;
  const now = new Date();

  if (answered) {
    if (cadence?.cancelRedialsOnAnswer) {
      await prisma.lead.update({ where: { id: leadId }, data: { redialsCancelledOn: now, nextDialAt: null } });
    }
    return;
  }

  if (!cadence) return; // dial plans already set nextDialAt in leadCallEnded

  if (cadence.missedCallSms && lead.assignedCallerId && textingAllowed(lead, campaign)) {
    const withToken = await ensureCallbackToken(lead);
    await sendSms({ tenantId: campaign.tenantId, campaignId: campaign.id, leadId: lead.id, from: lead.assignedCallerId, to: lead.phone, body: renderTemplate(cadence.missedCallSms, vars(withToken, lead.assignedCallerId)), purpose: "missed_call" });
  }

  const since = new Date(now.getTime() - 24 * 3600_000);
  const attempts24h = await prisma.call.count({ where: { leadId, direction: "OUTBOUND", dialedAt: { gte: since } } });
  let next: Date | null;
  if (attempts24h >= cadence.maxAttemptsPerDay) {
    // Earliest attempt in the window ages out, then the gap applies.
    const oldest = await prisma.call.findFirst({ where: { leadId, direction: "OUTBOUND", dialedAt: { gte: since } }, orderBy: { dialedAt: "asc" } });
    next = new Date((oldest?.dialedAt.getTime() ?? now.getTime()) + 24 * 3600_000);
  } else {
    next = now;
  }
  if (lead.timezone) {
    next = nextAttemptAt({
      zone: lead.timezone,
      now: next,
      lastAttemptAt: now,
      lastDaypart: (lead.lastAttemptDaypart as Daypart | null) ?? null,
      minGapMinutes: cadence.minGapMinutes,
      rotateDayparts: cadence.rotateDayparts,
      windows: parseDayparts(cadence.dayparts),
    });
  } else {
    next = new Date(Math.max(next.getTime(), now.getTime() + cadence.minGapMinutes * 60_000));
  }
  await prisma.lead.updateMany({ where: { id: leadId, status: { notIn: ["DNC", "BLOCKED", "FINISHED", "CALLBACK"] } }, data: { nextDialAt: next } });
}
