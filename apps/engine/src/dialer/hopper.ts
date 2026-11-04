// Which lead to dial next, and whether it may be dialed now.
//
// Lists carry a priority tier and optionally a cadence. The campaign decides
// how tiers share the dialer (strict priority or weighted round robin). A
// list with a cadence dials by the cadence's caps, gap and dayparts; a list
// without one dials by the campaign's dial plans. Compliance (window, state
// caps) applies to both.
import { prisma, type CadenceProfile, type Campaign, type DialPlan, type Lead, type List } from "@strowger/db";
import { daypartOf, localParts, parseDayparts } from "@strowger/shared/cadence";
import { evaluateDialWindow, type DialDecision } from "@strowger/shared/compliance";

export interface Eligibility {
  decision: DialDecision;
  plan: DialPlan | null;
  attemptsToday: number;
}

type LeadWithList = Lead & { list: List & { cadence: CadenceProfile | null } };

function ageDays(lead: Lead, now: Date): number {
  return Math.floor((now.getTime() - lead.postedAt.getTime()) / 86_400_000);
}

export function planFor(plans: DialPlan[], lead: Lead, now: Date): DialPlan | null {
  const age = ageDays(lead, now);
  const matches = plans.filter((p) => p.active && (p.leadType === null || p.leadType === lead.leadType) && age >= p.ageFromDays && (p.ageToDays === null || age <= p.ageToDays));
  matches.sort((a, b) => Number(b.leadType !== null) - Number(a.leadType !== null) || (a.ageToDays ?? 9999) - (b.ageToDays ?? 9999));
  return matches[0] ?? null;
}

function localDayStart(timezone: string, now: Date): Date {
  const p = localParts(timezone, now);
  if (!p) return new Date(now.getTime() - 86_400_000);
  return new Date(now.getTime() - p.hourFrac * 3_600_000 - now.getSeconds() * 1000);
}

export async function attemptsToday(campaignId: string, phone: string, timezone: string | null, now = new Date()): Promise<number> {
  const since = timezone ? localDayStart(timezone, now) : new Date(now.getTime() - 86_400_000);
  return prisma.call.count({ where: { campaignId, phone, direction: "OUTBOUND", dialedAt: { gte: since } } });
}

export async function eligibility(campaign: Campaign, plans: DialPlan[], lead: LeadWithList, now = new Date()): Promise<Eligibility> {
  const cadence = lead.list.cadence;
  const plan = cadence ? null : planFor(plans, lead, now);
  const attempts = await attemptsToday(campaign.id, lead.phone, lead.timezone, now);

  // Cadence-specific gates before the shared compliance window.
  if (cadence) {
    if (lead.redialsCancelledOn && lead.redialsCancelledOn.toDateString() === now.toDateString()) {
      return { decision: { allowed: false, reason: "Answered today; automated redials cancelled", rule: "cadence" }, plan, attemptsToday: attempts };
    }
    if (lead.lastAttemptAt && now.getTime() - lead.lastAttemptAt.getTime() < cadence.minGapMinutes * 60_000) {
      return { decision: { allowed: false, reason: `Within the ${cadence.minGapMinutes}-minute gap`, rule: "cadence" }, plan, attemptsToday: attempts };
    }
    if (cadence.rotateDayparts && lead.timezone) {
      const p = localParts(lead.timezone, now);
      const part = p ? daypartOf(p.hourFrac, parseDayparts(cadence.dayparts)) : null;
      if (!part) return { decision: { allowed: false, reason: "Outside the cadence dayparts", rule: "cadence" }, plan, attemptsToday: attempts };
      if (part === lead.lastAttemptDaypart && lead.lastAttemptAt && now.getTime() - lead.lastAttemptAt.getTime() < 20 * 3600_000) {
        return { decision: { allowed: false, reason: `Already tried in the ${part.toLowerCase()} window`, rule: "cadence" }, plan, attemptsToday: attempts };
      }
    }
  }

  const decision = evaluateDialWindow({
    timezone: lead.timezone,
    state: lead.state,
    campaignStartHour: campaign.localWindowStart,
    campaignEndHour: campaign.localWindowEnd,
    attemptsAllowedPerDay: cadence?.maxAttemptsPerDay ?? plan?.attemptsPerDay ?? campaign.maxAttemptsPerDay,
    attemptsToday: attempts,
    now,
  });
  return { decision, plan, attemptsToday: attempts };
}

/** Order lists for a campaign: strict tiers, or a weighted rotation across tiers. */
function orderLists(campaign: Campaign, lists: List[], tick: number): List[] {
  const sorted = lists.slice().sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  if (campaign.listSelection === "STRICT_PRIORITY") return sorted;
  // Weighted round robin: tier 1 gets 3 turns, tier 2 gets 2, tier 3+ gets 1.
  const weight = (p: number) => (p <= 1 ? 3 : p === 2 ? 2 : 1);
  const wheel: List[] = [];
  for (const l of sorted) for (let i = 0; i < weight(l.priority); i++) wheel.push(l);
  if (wheel.length === 0) return sorted;
  const start = tick % wheel.length;
  const seen = new Set<string>();
  const out: List[] = [];
  for (let i = 0; i < wheel.length; i++) {
    const l = wheel[(start + i) % wheel.length]!;
    if (!seen.has(l.id)) {
      seen.add(l.id);
      out.push(l);
    }
  }
  return out;
}

let rrTick = 0;

export type Reservation = { lead: LeadWithList; plan: DialPlan | null; cadence: CadenceProfile | null } | { lead: null; reason: string };

/**
 * Pick and reserve the next lead for an agent. Callbacks due come first, then
 * lists in priority order, each in the campaign's hopper order.
 */
export async function reserveNextLead(campaign: Campaign, agentId: string): Promise<Reservation> {
  const now = new Date();
  const plans = await prisma.dialPlan.findMany({ where: { campaignId: campaign.id, active: true } });

  const due = await prisma.callback.findFirst({
    where: {
      campaignId: campaign.id,
      status: "SCHEDULED",
      dueAt: { lte: now },
      OR: [{ agentId }, { scope: "CAMPAIGN" }, { agentId: { not: agentId }, dueAt: { lte: new Date(now.getTime() - campaign.callbackOwnerMinutes * 60_000) } }],
    },
    orderBy: { dueAt: "asc" },
    include: { lead: { include: { list: { include: { cadence: true } } } } },
  });
  if (due && due.lead.status !== "DNC" && due.lead.status !== "BLOCKED") {
    const e = await eligibility(campaign, plans, due.lead, now);
    if (e.decision.allowed) {
      await prisma.$transaction([
        prisma.callback.update({ where: { id: due.id }, data: { status: "OFFERED" } }),
        prisma.lead.update({ where: { id: due.lead.id }, data: { status: "DIALING", ownerId: agentId } }),
      ]);
      return { lead: due.lead, plan: e.plan, cadence: due.lead.list.cadence };
    }
  }

  const lists = await prisma.list.findMany({ where: { campaignId: campaign.id, status: "ACTIVE" } });
  const ordered = orderLists(campaign, lists, rrTick++);
  const order = campaign.hopperOrder === "FIFO" ? ("asc" as const) : ("desc" as const);
  let lastReason = "No leads are waiting in this campaign's lists";
  let sawAny = false;

  for (const list of ordered) {
    const candidates = await prisma.lead.findMany({
      where: {
        listId: list.id,
        status: { in: ["NEW", "CONTACTED", "CALLBACK"] },
        scrubStatus: { notIn: ["DNC", "LITIGATOR"] },
        timezone: { not: null },
        OR: [{ nextDialAt: null }, { nextDialAt: { lte: now } }],
        AND: [{ OR: [{ ownerId: null }, { ownerId: agentId }] }],
      },
      orderBy: [{ postedAt: order }],
      take: 25,
      include: { list: { include: { cadence: true } } },
    });
    if (candidates.length) sawAny = true;
    for (const lead of candidates) {
      const e = await eligibility(campaign, plans, lead, now);
      if (!e.decision.allowed) {
        lastReason = e.decision.reason;
        await prisma.lead.update({ where: { id: lead.id }, data: { nextDialAt: new Date(now.getTime() + 30 * 60_000) } }).catch(() => undefined);
        continue;
      }
      const reserved = await prisma.lead.updateMany({ where: { id: lead.id, status: lead.status, ownerId: lead.ownerId }, data: { status: "DIALING", ownerId: agentId } });
      if (reserved.count === 1) return { lead, plan: e.plan, cadence: lead.list.cadence };
    }
  }
  return { lead: null, reason: sawAny ? `Nothing dialable right now: ${lastReason}` : lastReason };
}

/** Put a reserved lead back without dialing it (agent skipped or logged out). */
export async function releaseLead(leadId: string, delayMinutes = 60): Promise<void> {
  await prisma.lead.updateMany({
    where: { id: leadId, status: "DIALING" },
    data: { status: "NEW", ownerId: null, nextDialAt: new Date(Date.now() + delayMinutes * 60_000) },
  });
}
