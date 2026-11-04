// Mid-call controls an agent uses: hold, warm transfer to a closer, and a
// manual dial of a typed number under the same compliance rules.
import { prisma, type Campaign } from "@strowger/db";
import { evaluateDialWindow } from "@strowger/shared/compliance";
import { resolveZone } from "@strowger/shared/geo";
import { normalizePhone } from "@strowger/shared/phone";
import { getAgent, listAgents, patchAgent, type AgentLive } from "../agents/state";
import { hookUrl, jambonz } from "../jambonz/client";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";
import { dialLeadForAgent } from "./calls";

type Result = { ok: true } | { ok: false; error: string };

export async function holdCall(callId: string, agentId: string, hold: boolean): Promise<Result> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || call.agentId !== agentId) return { ok: false, error: "Not your call" };
  if (!call.providerCallId || call.endedAt) return { ok: false, error: "Call is not live" };
  try {
    await jambonz.calls.update(call.providerCallId, { conf_hold_status: hold ? "hold" : "unhold" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  emitToAgent(agentId, "call:update", { callId, status: hold ? "held" : "bridged" });
  return { ok: true };
}

/** Closers (or any Ready agent) on this campaign who can take a transfer now. */
export async function transferTargets(tenantId: string, campaignId: string | null, exceptUserId: string): Promise<Array<{ userId: string; name: string; mode: string; since: number }>> {
  const live = (await listAgents(tenantId)).filter((a) => a.userId !== exceptUserId && a.state === "READY" && a.agentCallSid && !a.currentCallId && !a.reservedLeadId && (!campaignId || a.campaignId === campaignId));
  if (live.length === 0) return [];
  const [users, assignments] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: live.map((a) => a.userId) } }, select: { id: true, firstName: true, lastName: true, email: true } }),
    campaignId ? prisma.campaignAgent.findMany({ where: { campaignId, userId: { in: live.map((a) => a.userId) } } }) : Promise.resolve([]),
  ]);
  return live
    .map((a) => {
      const u = users.find((x) => x.id === a.userId);
      const ca = assignments.find((x) => x.userId === a.userId);
      return { userId: a.userId, name: u ? (u.firstName ? `${u.firstName} ${u.lastName ?? ""}`.trim() : u.email) : a.userId, mode: ca?.agentMode ?? "BOTH", since: a.since };
    })
    .sort((a, b) => (a.mode === "CLOSER" ? -1 : 1) - (b.mode === "CLOSER" ? -1 : 1) || a.since - b.since);
}

/**
 * Warm transfer: the lead leg leaves the fronter's room and joins the
 * closer's. The fronter goes to wrap-up (and dispositions the first half),
 * the closer is on the call. Both see the same lead.
 */
export async function transferCall(callId: string, fromAgentId: string, toAgentId: string): Promise<Result> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || call.agentId !== fromAgentId) return { ok: false, error: "Not your call" };
  if (!call.providerCallId || call.endedAt) return { ok: false, error: "Call is not live" };
  const target = await getAgent(toAgentId);
  if (!target || target.state !== "READY" || !target.agentCallSid || target.currentCallId) return { ok: false, error: "That agent is no longer free" };

  // Claim the closer first so nothing else lands on them while the leg moves.
  await patchAgent(toAgentId, { state: "ON_CALL", currentCallId: callId, reservedLeadId: null });
  try {
    await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/transfer", { callId, toAgentId }), method: "POST" });
  } catch (e) {
    await patchAgent(toAgentId, { state: "READY", currentCallId: null });
    log.warn({ err: e, callId }, "transfer redirect failed");
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // The call continues under the closer; the fronter's half is recorded as a transfer.
  const second = await prisma.call.create({
    data: { tenantId: call.tenantId, campaignId: call.campaignId, leadId: call.leadId, agentId: toAgentId, direction: call.direction, phone: call.phone, callerId: call.callerId, answeredAt: new Date(), bridgedAt: new Date(), providerData: { transferredFrom: call.id } },
  });
  await prisma.transfer.create({ data: { tenantId: call.tenantId, callId: call.id, fromAgentId, toAgentId, kind: "WARM", completedAt: new Date() } });
  // The provider call sid now belongs to the closer's record for status hooks.
  await prisma.call.update({ where: { id: call.id }, data: { providerCallId: null, endedAt: new Date(), outcome: call.outcome ?? "BRIDGED", notes: [call.notes, `Transferred to agent ${toAgentId}`].filter(Boolean).join("\n") } });
  await prisma.call.update({ where: { id: second.id }, data: { providerCallId: call.providerCallId } });
  const { redis } = await import("../redis");
  await redis.set(`callsid:${call.providerCallId}`, second.id, "EX", 6 * 3600);
  if (call.leadId) {
    await prisma.lead.update({ where: { id: call.leadId }, data: { ownerId: toAgentId } });
    await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.leadId, kind: "NOTE", actorId: fromAgentId, data: { note: "Warm transfer to closer", toAgentId } } });
  }
  await patchAgent(toAgentId, { currentCallId: second.id });
  await patchAgent(fromAgentId, { state: "WRAP_UP" });
  emitToAgent(toAgentId, "call:update", { callId: second.id, status: "answered", leadId: call.leadId, transfer: true });
  emitToAgent(fromAgentId, "call:update", { callId: call.id, status: "ended", outcome: "TRANSFERRED" });
  emitToTenant(call.tenantId, "floor:call", { callId: second.id, status: "transferred", fromAgentId, toAgentId });
  return { ok: true };
}

/** Dial a number the agent typed. Same window and DNC rules; attaches to a lead if one exists. */
export async function manualDial(tenantId: string, agentId: string, raw: string): Promise<{ ok: true; callId: string } | { ok: false; error: string }> {
  const phone = normalizePhone(raw);
  if (!phone) return { ok: false, error: "That is not a dialable US number" };
  const live = await getAgent(agentId);
  if (!live?.campaignId || live.state !== "READY") return { ok: false, error: "Be logged in and Ready first" };
  const campaign = (await prisma.campaign.findFirst({ where: { id: live.campaignId, tenantId } })) as Campaign | null;
  if (!campaign) return { ok: false, error: "Campaign not found" };
  const dnc = await prisma.dncEntry.findFirst({ where: { tenantId, phone, OR: [{ scope: "SYSTEM" }, { scope: "CAMPAIGN", campaignId: campaign.id }] } });
  if (dnc) return { ok: false, error: "That number is on the do-not-call list" };

  let lead = await prisma.lead.findFirst({ where: { tenantId, phone }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }] });
  const zone = resolveZone({ zip: lead?.zip, state: lead?.state, phone });
  const d = evaluateDialWindow({ timezone: lead?.timezone ?? zone?.timezone ?? null, state: lead?.state ?? zone?.state ?? null, campaignStartHour: campaign.localWindowStart, campaignEndHour: campaign.localWindowEnd, attemptsAllowedPerDay: campaign.maxAttemptsPerDay, attemptsToday: 0, allowedHours: campaign.allowedHours as number[][] | null });
  if (!d.allowed) return { ok: false, error: `${d.reason} (${d.rule})` };

  if (!lead) {
    // Keep manual dials in a per-campaign "Manual dials" list so they report like everything else.
    let list = await prisma.list.findFirst({ where: { tenantId, campaignId: campaign.id, name: "Manual dials" } });
    if (!list) list = await prisma.list.create({ data: { tenantId, campaignId: campaign.id, name: "Manual dials", source: "UPLOAD", priority: 9 } });
    lead = await prisma.lead.create({ data: { tenantId, listId: list.id, phone, timezone: zone?.timezone ?? null, state: zone?.state ?? null, status: "DIALING", ownerId: agentId, scrubStatus: "PENDING" } });
  } else {
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "DIALING", ownerId: agentId } });
  }
  await patchAgent(agentId, { reservedLeadId: lead.id });
  const r = await dialLeadForAgent(campaign, lead, agentId);
  if (!r.ok) await patchAgent(agentId, { reservedLeadId: null });
  return r;
}

export type { AgentLive };
