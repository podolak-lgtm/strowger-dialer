// Inbound calls to one of our numbers: a lead calling back. Route to the
// agent who owns the lead if they are Ready, else the longest-idle Ready
// agent on the number's campaign (or anywhere in the tenant), else take a
// message and book a callback so the lead is dialed back as soon as someone
// is free.
import { prisma, type Call } from "@strowger/db";
import { normalizePhone } from "@strowger/shared/phone";
import { getAgent, listAgents, patchAgent, type AgentLive } from "../agents/state";
import { agentRoom, hookUrl } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";

type Verb = Record<string, unknown>;

export interface InboundResult {
  verbs: Verb[];
  call: Call | null;
}

async function readyFor(tenantId: string, campaignId: string | null, preferAgentId: string | null): Promise<AgentLive | null> {
  const live = (await listAgents(tenantId)).filter((a) => a.state === "READY" && a.agentCallSid && !a.currentCallId && !a.reservedLeadId);
  if (preferAgentId) {
    const own = live.find((a) => a.userId === preferAgentId);
    if (own) return own;
  }
  const onCampaign = campaignId ? live.filter((a) => a.campaignId === campaignId) : [];
  const pool = onCampaign.length ? onCampaign : live;
  pool.sort((a, b) => a.since - b.since);
  return pool[0] ?? null;
}

export async function handleInboundCall(callSid: string, fromRaw: string, toRaw: string): Promise<InboundResult> {
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);
  if (!to) return { verbs: [{ verb: "hangup" }], call: null };
  const number = await prisma.callerIdNumber.findFirst({ where: { phone: to }, include: { campaign: true } });
  if (!number) {
    log.warn({ to, from }, "inbound call to a number we do not own");
    return { verbs: [{ verb: "hangup" }], call: null };
  }
  const tenantId = number.tenantId;
  const lead = from ? await prisma.lead.findFirst({ where: { tenantId, phone: from }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }], include: { list: { select: { campaignId: true } } } }) : null;
  const campaignId = number.campaignId ?? lead?.list.campaignId ?? null;
  const campaign = campaignId ? await prisma.campaign.findUnique({ where: { id: campaignId } }) : null;

  const call = await prisma.call.create({
    data: { tenantId, campaignId, leadId: lead?.id ?? null, direction: "INBOUND", phone: from ?? "unknown", callerId: to, providerCallId: callSid, answeredAt: new Date() },
  });
  await redis.set(`callsid:${callSid}`, call.id, "EX", 6 * 3600);
  if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "ANSWERED", data: { inbound: true, callId: call.id } } });

  const agent = await readyFor(tenantId, campaignId, lead?.ownerId ?? null);
  if (agent) {
    await prisma.call.update({ where: { id: call.id }, data: { agentId: agent.userId } });
    await patchAgent(agent.userId, { state: "ON_CALL", currentCallId: call.id, reservedLeadId: null });
    if (lead) await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: agent.userId, status: lead.status === "NEW" ? "CONTACTED" : lead.status } });
    emitToAgent(agent.userId, "call:update", { callId: call.id, status: "answered", leadId: lead?.id ?? null, inbound: true, from });
    emitToTenant(tenantId, "floor:call", { callId: call.id, status: "inbound", agentId: agent.userId });
    const verbs: Verb[] = [];
    if (campaign?.disclosureOn && campaign.disclosureAudioId) {
      const a = await prisma.audioAsset.findUnique({ where: { id: campaign.disclosureAudioId } });
      if (a) verbs.push({ verb: "play", url: a.storageUrl });
    }
    verbs.push(
      { verb: "conference", name: agentRoom(agent.userId), memberTag: "lead", startConferenceOnEnter: false, endConferenceOnExit: false, beep: false, statusHook: hookUrl("/jambonz/conf", { callId: call.id, tenantId }), statusEvents: ["join", "leave"], actionHook: hookUrl("/jambonz/conf-exit", { callId: call.id }) },
      { verb: "hangup" },
    );
    return { verbs, call };
  }

  // Nobody free: book a callback for the next free agent and let the caller leave a message.
  if (lead && campaignId) {
    await prisma.callback.create({ data: { tenantId, campaignId, leadId: lead.id, agentId: lead.ownerId ?? null, scope: lead.ownerId ? "AGENT" : "CAMPAIGN", dueAt: new Date(), note: "Called in while nobody was free" } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "CALLBACK", nextDialAt: new Date() } });
    await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "CALLBACK_SET", data: { source: "inbound_no_agent", callId: call.id } } });
  }
  await prisma.call.update({ where: { id: call.id }, data: { outcome: "NO_ANSWER", notes: "Inbound, no agent free; callback booked" } });
  emitToTenant(tenantId, "floor:call", { callId: call.id, status: "inbound_missed" });
  const hold = campaign?.safeHarborAudioId ? await prisma.audioAsset.findUnique({ where: { id: campaign.safeHarborAudioId } }) : null;
  // Record a short message (jambonz 'record' needs cloud recording on the account; the pause keeps it simple until then).
  return { verbs: [...(hold ? [{ verb: "play", url: hold.storageUrl }] : []), { verb: "pause", length: 2 }, { verb: "hangup" }], call };
}

export { getAgent };
