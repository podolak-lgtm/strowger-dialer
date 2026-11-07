// Ratio dialing. Every half second, for each active RATIO campaign: count
// agents who are Ready with their line up, count calls already in flight,
// and place the difference up to the effective ratio. The effective ratio
// falls as the rolling 30-day abandon rate approaches the campaign's cap and
// is 1:1 at the cap. Nothing is dialed when nobody is Ready.
//
// An unreserved call that a human answers is bridged to the longest-idle
// Ready agent (routes.ts). If none is free within the abandon timer the
// safe-harbor message plays and the call is an abandon, counted in the
// ledger that drives the throttle.
import { prisma, type Campaign, type Lead } from "@strowger/db";
import { toE164 } from "@strowger/shared/phone";
import { dialableNow, listAgents, type AgentLive } from "../agents/state";
import { config } from "../config";
import { agentRoom, hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";
import { amdRecognizer } from "../assist/live";
import { log } from "../log";
import { redis } from "../redis";
import { emitToTenant } from "../realtime";
import { pickCallerId } from "./calls";
import { eligibility } from "./hopper";
import { inboundHolds } from "../inbound/queues";

const inflightKey = (campaignId: string) => `campaign:${campaignId}:inflight`;
const sidKey = (sid: string) => `callsid:${sid}`;

export async function addInflight(campaignId: string, callId: string): Promise<void> {
  await redis.sadd(inflightKey(campaignId), callId);
}
export async function removeInflight(campaignId: string, callId: string): Promise<void> {
  await redis.srem(inflightKey(campaignId), callId);
}

/** Agents on this campaign who can take a bridged call right now, longest idle first. */
export async function readyAgents(campaign: Campaign): Promise<AgentLive[]> {
  const live = (await listAgents(campaign.tenantId)).filter((a) => a.campaignId === campaign.id && a.state === "READY" && a.agentCallSid && !a.currentCallId && !a.reservedLeadId);
  if (live.length === 0) return [];
  const assignments = await prisma.campaignAgent.findMany({ where: { campaignId: campaign.id, userId: { in: live.map((a) => a.userId) } } });
  return live
    .filter((a) => {
      const ca = assignments.find((x) => x.userId === a.userId);
      return !ca || ca.agentMode !== "CLOSER" || (campaign.closersMayDial && ca.outboundOn);
    })
    .sort((a, b) => a.since - b.since);
}

/** Rolling 30-day abandon rate from the ledger, cached briefly. */
export async function abandonRate(campaignId: string): Promise<{ rate: number; answered: number; abandoned: number }> {
  const cacheKey = `campaign:${campaignId}:abandon`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as { rate: number; answered: number; abandoned: number };
  const since = new Date(Date.now() - 30 * 86_400_000);
  const agg = await prisma.abandonLedger.aggregate({ where: { campaignId, day: { gte: since } }, _sum: { answered: true, abandoned: true } });
  const answered = agg._sum.answered ?? 0;
  const abandoned = agg._sum.abandoned ?? 0;
  const out = { rate: answered > 0 ? (abandoned / answered) * 100 : 0, answered, abandoned };
  await redis.set(cacheKey, JSON.stringify(out), "EX", 30);
  return out;
}

export async function recordLedger(campaign: Campaign, field: "answered" | "abandoned"): Promise<void> {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  await prisma.abandonLedger.upsert({
    where: { campaignId_day: { campaignId: campaign.id, day } },
    create: { tenantId: campaign.tenantId, campaignId: campaign.id, day, answered: field === "answered" ? 1 : 0, abandoned: field === "abandoned" ? 1 : 0 },
    update: { [field]: { increment: 1 } },
  });
  await redis.del(`campaign:${campaign.id}:abandon`);
}

/** The ratio actually used this tick. */
export function effectiveRatio(campaign: Campaign, stats: { rate: number; answered: number }): number {
  const ratio = Number(campaign.ratio);
  const max = Number(campaign.maxRatio);
  const cap = Number(campaign.abandonCapPct);
  const warn = Number(campaign.abandonWarnPct);
  let r = Math.min(ratio, max);
  if (stats.answered < 50) return Math.min(r, 2); // thin sample: be conservative
  if (stats.rate >= cap) return 1;
  if (stats.rate >= warn && cap > warn) {
    const t = (stats.rate - warn) / (cap - warn); // 0 at warn, 1 at cap
    r = r - (r - 1) * t;
  }
  return Math.max(1, Math.round(r * 10) / 10);
}

/** Reserve the next eligible lead for the campaign itself (no agent yet). */
async function reserveForCampaign(campaign: Campaign): Promise<Lead | null> {
  const now = new Date();
  const plans = await prisma.dialPlan.findMany({ where: { campaignId: campaign.id, active: true } });
  const tenant = await prisma.tenant.findUnique({ where: { id: campaign.tenantId }, select: { settings: true } });
  const scrubRequired = Boolean((tenant?.settings as { scrubRequired?: boolean } | null)?.scrubRequired);
  const lists = await prisma.list.findMany({ where: { campaignId: campaign.id, status: "ACTIVE" }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
  const order = campaign.hopperOrder === "FIFO" ? ("asc" as const) : ("desc" as const);
  for (const list of lists) {
    const candidates = await prisma.lead.findMany({
      where: {
        listId: list.id,
        status: { in: ["NEW", "CONTACTED"] },
        ownerId: null,
        scrubStatus: scrubRequired ? "CLEAN" : { notIn: ["DNC", "LITIGATOR"] },
        timezone: { not: null },
        OR: [{ nextDialAt: null }, { nextDialAt: { lte: now } }],
      },
      orderBy: [{ postedAt: order }],
      take: 10,
      include: { list: { include: { cadence: true } } },
    });
    for (const lead of candidates) {
      const e = await eligibility(campaign, plans, lead, now);
      if (!e.decision.allowed) {
        await prisma.lead.update({ where: { id: lead.id }, data: { nextDialAt: new Date(now.getTime() + 30 * 60_000) } }).catch(() => undefined);
        continue;
      }
      const r = await prisma.lead.updateMany({ where: { id: lead.id, status: lead.status, ownerId: null }, data: { status: "DIALING" } });
      if (r.count === 1) return lead;
    }
  }
  return null;
}

/** Place one unreserved outbound call for the campaign. */
async function dialUnreserved(campaign: Campaign, lead: Lead): Promise<boolean> {
  const callerId = lead.assignedCallerId ?? (await pickCallerId(campaign, lead.phone));
  if (!callerId) {
    log.warn({ campaignId: campaign.id }, "pacer: no caller ID available");
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "NEW", nextDialAt: new Date(Date.now() + 15 * 60_000) } });
    return false;
  }
  const call = await prisma.call.create({ data: { tenantId: campaign.tenantId, campaignId: campaign.id, leadId: lead.id, direction: "OUTBOUND", phone: lead.phone, callerId } });
  await addInflight(campaign.id, call.id);
  try {
    type CreateReq = Parameters<typeof jambonz.calls.create>[0];
    const amdRec = campaign.amdEnabled ? await amdRecognizer() : null;
    const req = {
      from: toE164(callerId),
      to: { type: "phone", number: toE164(lead.phone) },
      ...(config.JAMBONZ_CARRIER ? { trunk: config.JAMBONZ_CARRIER } : {}),
      ...(config.JAMBONZ_APPLICATION_SID
        ? { application_sid: config.JAMBONZ_APPLICATION_SID }
        : { call_hook: { url: hookUrl("/jambonz/call"), method: "post" as const }, call_status_hook: { url: hookUrl("/jambonz/status"), method: "post" as const } }),
      timeout: 30,
      tag: { kind: "lead", callId: call.id, campaignId: campaign.id, tenantId: campaign.tenantId, pacer: true },
      // AMD on our speech-to-text vendor only (see dialer/calls.ts); none usable = no AMD on this call.
      ...(amdRec
        ? { amd: { actionHook: hookUrl("/jambonz/amd", { callId: call.id }), timers: { decisionTimeoutMs: 5000, noSpeechTimeoutMs: 3500, greetingCompletionTimeoutMs: 1200 }, recognizer: amdRec } }
        : {}),
    } as CreateReq;
    const sid = await jambonz.calls.create(req);
    await redis.set(sidKey(sid), call.id, "EX", 6 * 3600);
    await prisma.call.update({ where: { id: call.id }, data: { providerCallId: sid } });
    await prisma.lead.update({ where: { id: lead.id }, data: { attemptsTotal: { increment: 1 }, lastAttemptAt: new Date(), assignedCallerId: callerId } });
    await prisma.leadEvent.create({ data: { tenantId: campaign.tenantId, leadId: lead.id, kind: "DIAL", data: { callId: call.id, callerId, pacer: true } } });
    return true;
  } catch (e) {
    log.error({ err: e, callId: call.id }, "pacer: create call failed");
    await removeInflight(campaign.id, call.id);
    await prisma.call.update({ where: { id: call.id }, data: { outcome: "FAILED", endedAt: new Date(), providerData: { error: String(e) } } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "NEW", nextDialAt: new Date(Date.now() + 15 * 60_000) } });
    return false;
  }
}

export interface PacingSnapshot {
  campaignId: string;
  ready: number;
  /** Ready agents left out for inbound (blending). */
  heldForInbound: number;
  inflight: number;
  ratio: number;
  abandonRate: number;
  dialed: number;
}

/** One pass over every active ratio campaign. */
export async function pacingTick(): Promise<PacingSnapshot[]> {
  if (!jambonzConfigured) return [];
  const campaigns = await prisma.campaign.findMany({ where: { status: "ACTIVE", dialMode: "RATIO" } });
  const out: PacingSnapshot[] = [];
  const holdsByTenant = new Map<string, Set<string>>();
  for (const campaign of campaigns) {
    // Blending: agents held for an inbound queue (oldest caller past blendWaitSeconds, or reserved) get no new outbound calls.
    if (!holdsByTenant.has(campaign.tenantId)) holdsByTenant.set(campaign.tenantId, await inboundHolds(campaign.tenantId));
    const held = holdsByTenant.get(campaign.tenantId)!;
    // Agents who clicked Ready under 10 s ago are not dialed for yet (agents/state.ts READY_DIAL_GRACE_MS).
    const ready = (await readyAgents(campaign)).filter((a) => !held.has(a.userId) && dialableNow(a));
    const inflight = await redis.scard(inflightKey(campaign.id));
    const stats = await abandonRate(campaign.id);
    const ratio = effectiveRatio(campaign, stats);
    const want = ready.length === 0 ? 0 : Math.max(0, Math.floor(ready.length * ratio) - inflight);
    let dialed = 0;
    for (let i = 0; i < want && i < 10; i++) {
      const lead = await reserveForCampaign(campaign);
      if (!lead) break;
      if (await dialUnreserved(campaign, lead)) dialed++;
    }
    const snap = { campaignId: campaign.id, ready: ready.length, heldForInbound: held.size, inflight: inflight + dialed, ratio, abandonRate: Math.round(stats.rate * 100) / 100, dialed };
    out.push(snap);
    if (dialed || inflight) emitToTenant(campaign.tenantId, "floor:pacing", snap);
  }
  return out;
}

/** Start the loop; one instance holds the lock at a time. */
export function startPacing(intervalMs = 500): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const got = await redis.set("lock:pacing", String(process.pid), "PX", intervalMs * 4, "NX");
      if (got) {
        await pacingTick();
        await redis.del("lock:pacing");
      }
    } catch (e) {
      log.error({ err: e }, "pacing tick failed");
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(t);
}

export { agentRoom };
