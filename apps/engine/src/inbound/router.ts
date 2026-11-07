// Inbound contact center: where a call to one of our numbers goes.
//
//   number.schedule closed   → the schedule's after-hours action
//   number.geoRoutes match   → that queue (caller's state / area code)
//   number.routeTo = CAMPAIGN  a lead calling back → owning / next Ready agent
//                    USER      a direct DID → that agent, else their voicemail
//                    IVR       menu → options (incl. GEO), extensions, voicemail
//                    QUEUE     ACD queue → best agent by the queue's strategy (queues.ts)
import { prisma } from "@strowger/db";
import { callerGeo, matchGeoRoute } from "@strowger/shared/inbound";
import { normalizePhone } from "@strowger/shared/phone";
import { getAgent, listAgents } from "../agents/state";
import { redis } from "../redis";
import { audio, boxForUser, claimAgent, isFree, ivrVerbs, joinAgentVerbs, voicemailVerbs, type Verbs } from "./common";
import { closedVerbs, enterQueue, scheduleState } from "./queues";

export { boxForUser, ivrVerbs, joinAgentVerbs, voicemailVerbs, type Verbs } from "./common";
export { enterQueue, leaveQueue, overflowVerbs, queueTick, queueWaitVerbs } from "./queues";

// ── Geographic routing ──────────────────────────────────────────────────────

/** The queue a number's or an IVR's geo rules send this caller to, or null. */
async function geoQueueVerbs(where: { numberId: string } | { ivrId: string }, tenantId: string, callId: string): Promise<Verbs | null> {
  const rules = await prisma.geoRoute.findMany({ where: { tenantId, ...where } });
  if (rules.length === 0) return null;
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: { select: { state: true, zip: true } } } });
  if (!call) return null;
  const geo = callerGeo(call.phone, call.lead);
  const rule = matchGeoRoute(rules, geo);
  if (!rule) return null;
  const q = await prisma.queue.findFirst({ where: { id: rule.targetQueueId, tenantId }, include: { schedule: true } });
  if (!q) return null;
  await prisma.call.update({ where: { id: callId }, data: { providerData: { ...(call.providerData as object), geoRoute: rule.name, geoState: geo.state, geoAreaCode: geo.areaCode } } });
  return enterQueue(q, callId);
}

// ── IVR ─────────────────────────────────────────────────────────────────────

type IvrOption = { digit: string; label?: string; action: "QUEUE" | "USER" | "VOICEMAIL" | "IVR" | "GEO" | "HANGUP"; targetId?: string | null };

/** Apply an IVR option (or the timeout action) to a live call. GEO uses the IVR's geo rules, with the option's queue as the fallback. */
export async function applyAction(tenantId: string, callId: string, action: string, targetId: string | null | undefined, fromPhone: string, ivrId?: string): Promise<Verbs> {
  switch (action) {
    case "QUEUE": {
      const q = targetId ? await prisma.queue.findFirst({ where: { id: targetId, tenantId }, include: { schedule: true } }) : null;
      return q ? enterQueue(q, callId) : [{ verb: "hangup" }];
    }
    case "GEO": {
      const routed = ivrId ? await geoQueueVerbs({ ivrId }, tenantId, callId) : null;
      if (routed) return routed;
      return targetId ? applyAction(tenantId, callId, "QUEUE", targetId, fromPhone) : [{ verb: "hangup" }];
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
      return applyAction(ivr.tenantId, callId, opt.action, opt.targetId, call.phone, ivr.id);
    }
    if (ivr.allowExtensions) {
      const user = await prisma.user.findFirst({ where: { tenantId: ivr.tenantId, extension: digits, active: true } });
      if (user) return ringUser(ivr.tenantId, user.id, callId, call.phone);
    }
  }
  if (attempt <= ivr.repeats && !(timedOut && attempt > ivr.repeats)) return ivrVerbs(ivr, callId, attempt + 1);
  return applyAction(ivr.tenantId, callId, ivr.timeoutAction, ivr.timeoutTargetId, call.phone, ivr.id);
}

// ── Direct to an agent ──────────────────────────────────────────────────────

export async function ringUser(tenantId: string, userId: string, callId: string, fromPhone: string): Promise<Verbs> {
  const live = await getAgent(userId);
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (live && isFree(live) && (await claimAgent(live, callId, call?.leadId ?? null, { direct: true, from: fromPhone }))) {
    return await joinAgentVerbs(callId, tenantId, userId);
  }
  const box = await boxForUser(tenantId, userId);
  return voicemailVerbs(box, callId, fromPhone);
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function routeInbound(callSid: string, fromRaw: string, toRaw: string): Promise<Verbs | null> {
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);
  if (!to) return null;
  const number = await prisma.callerIdNumber.findFirst({ where: { phone: to }, include: { campaign: true, ivr: true, queue: { include: { schedule: true } }, schedule: true } });
  if (!number) return null;
  const tenantId = number.tenantId;
  const lead = from ? await prisma.lead.findFirst({ where: { tenantId, phone: from }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }], include: { list: { select: { campaignId: true } } } }) : null;
  const campaignId = number.campaignId ?? number.queue?.campaignId ?? lead?.list.campaignId ?? null;
  const call = await prisma.call.create({ data: { tenantId, campaignId, leadId: lead?.id ?? null, direction: "INBOUND", phone: from ?? "unknown", callerId: to, providerCallId: callSid, answeredAt: new Date() } });
  await redis.set(`callsid:${callSid}`, call.id, "EX", 6 * 3600);
  if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "ANSWERED", data: { inbound: true, callId: call.id } } });
  const fromPhone = from ?? "unknown";

  // Business hours on the number come first: closed means the after-hours action, whatever the route.
  const hours = scheduleState(number.schedule);
  if (!hours.open && number.schedule) return closedVerbs(number.schedule, hours, call.id, fromPhone);

  // Geographic rules on the number: a match sends the caller to that queue.
  const geo = await geoQueueVerbs({ numberId: number.id }, tenantId, call.id);
  if (geo) return geo;

  switch (number.routeTo) {
    case "USER":
      return number.routeUserId ? ringUser(tenantId, number.routeUserId, call.id, fromPhone) : [{ verb: "hangup" }];
    case "IVR":
      return number.ivr ? ivrVerbs(number.ivr, call.id) : [{ verb: "hangup" }];
    case "QUEUE":
      return number.queue ? enterQueue(number.queue, call.id) : [{ verb: "hangup" }];
    default: {
      // Campaign callback: owner first, then the campaign, then anyone.
      const free = (await listAgents(tenantId)).filter(isFree);
      // The agent who last spoke to, texted or left a message for this person gets the call back first; then the owner; then whoever has waited longest.
      const preferredIds = [lead?.lastAgentId, lead?.ownerId].filter((x): x is string => Boolean(x));
      const owner = preferredIds.map((id) => free.find((a) => a.userId === id)).find(Boolean);
      const onCampaign = campaignId ? free.filter((a) => a.campaignId === campaignId).sort((a, b) => a.since - b.since) : [];
      const ordered = [owner, ...onCampaign, ...free.sort((a, b) => a.since - b.since)].filter((a): a is NonNullable<typeof a> => Boolean(a));
      // Atomic claim: the first of them nobody else is assigning right now.
      let agent: (typeof ordered)[number] | undefined;
      for (const a of ordered) {
        if (await claimAgent(a, call.id, lead?.id ?? null, { from: fromPhone })) {
          agent = a;
          break;
        }
      }
      if (agent) {
        const verbs: Verbs = [];
        if (number.campaign?.disclosureOn) {
          const d = await audio(number.campaign.disclosureAudioId);
          if (d) verbs.push({ verb: "play", url: d });
        }
        return [...verbs, ...(await joinAgentVerbs(call.id, tenantId, agent.userId))];
      }
      if (lead && campaignId) {
        await prisma.callback.create({ data: { tenantId, campaignId, leadId: lead.id, agentId: lead.ownerId ?? null, scope: lead.ownerId ? "AGENT" : "CAMPAIGN", dueAt: new Date(), note: "Called in while nobody was free" } });
        await prisma.lead.update({ where: { id: lead.id }, data: { status: "CALLBACK", nextDialAt: new Date() } });
      }
      // Take a message: in the box of the agent they were dealing with, else the campaign's box, so nothing is lost.
      const personal = lead?.lastAgentId ?? lead?.ownerId ?? null;
      const box = personal
        ? await boxForUser(tenantId, personal)
        : campaignId
          ? await prisma.voicemailBox.upsert({ where: { tenantId_name: { tenantId, name: `${number.campaign?.name ?? "Campaign"} callbacks` } }, create: { tenantId, name: `${number.campaign?.name ?? "Campaign"} callbacks` }, update: {} })
          : null;
      await prisma.call.update({ where: { id: call.id }, data: { outcome: "NO_ANSWER", notes: "Inbound, no agent free" } });
      return box ? voicemailVerbs(box, call.id, fromPhone) : [{ verb: "hangup" }];
    }
  }
}
