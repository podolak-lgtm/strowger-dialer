// Which lead to dial next, and whether it may be dialed now.
//
// Phase 2 reads straight from Postgres for preview mode. Phase 3 replaces
// the candidate query with the Redis hopper; the eligibility rules here stay.
import { prisma, type Campaign, type DialPlan, type Lead } from "@strowger/db";
import { evaluateDialWindow, type DialDecision } from "@strowger/shared/compliance";

export interface Eligibility {
  decision: DialDecision;
  plan: DialPlan | null;
  attemptsToday: number;
}

function ageDays(lead: Lead, now: Date): number {
  return Math.floor((now.getTime() - lead.postedAt.getTime()) / 86_400_000);
}

export function planFor(plans: DialPlan[], lead: Lead, now: Date): DialPlan | null {
  const age = ageDays(lead, now);
  const matches = plans.filter(
    (p) =>
      p.active &&
      (p.leadType === null || p.leadType === lead.leadType) &&
      age >= p.ageFromDays &&
      (p.ageToDays === null || age <= p.ageToDays),
  );
  // A plan naming the lead type beats a generic one; then the narrowest age band.
  matches.sort((a, b) => Number(b.leadType !== null) - Number(a.leadType !== null) || (a.ageToDays ?? 9999) - (b.ageToDays ?? 9999));
  return matches[0] ?? null;
}

/** Start of the lead's local day, so "attempts today" means the lead's today. */
function localDayStart(timezone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get("hour") % 24;
  const start = new Date(now.getTime() - hour * 3_600_000 - (now.getMinutes() * 60_000 + now.getSeconds() * 1000));
  return start;
}

export async function attemptsToday(campaignId: string, phone: string, timezone: string | null, now = new Date()): Promise<number> {
  const since = timezone ? localDayStart(timezone, now) : new Date(now.getTime() - 86_400_000);
  return prisma.call.count({ where: { campaignId, phone, direction: "OUTBOUND", dialedAt: { gte: since } } });
}

export async function eligibility(campaign: Campaign, plans: DialPlan[], lead: Lead, now = new Date()): Promise<Eligibility> {
  const plan = planFor(plans, lead, now);
  const attempts = await attemptsToday(campaign.id, lead.phone, lead.timezone, now);
  const decision = evaluateDialWindow({
    timezone: lead.timezone,
    state: lead.state,
    campaignStartHour: campaign.localWindowStart,
    campaignEndHour: campaign.localWindowEnd,
    attemptsAllowedPerDay: plan?.attemptsPerDay ?? campaign.maxAttemptsPerDay,
    attemptsToday: attempts,
    now,
  });
  return { decision, plan, attemptsToday: attempts };
}

/**
 * Pick and reserve the next lead for an agent in preview mode. Callbacks due
 * for this agent come first, then the campaign's hopper order.
 */
export async function reserveNextLead(campaign: Campaign, agentId: string): Promise<{ lead: Lead; plan: DialPlan | null } | { lead: null; reason: string }> {
  const now = new Date();
  const plans = await prisma.dialPlan.findMany({ where: { campaignId: campaign.id, active: true } });

  // 1. Callbacks due: the agent's own first, then campaign-scoped ones.
  const due = await prisma.callback.findFirst({
    where: {
      campaignId: campaign.id,
      status: "SCHEDULED",
      dueAt: { lte: now },
      OR: [{ agentId }, { scope: "CAMPAIGN" }, { agentId: { not: agentId }, dueAt: { lte: new Date(now.getTime() - campaign.callbackOwnerMinutes * 60_000) } }],
    },
    orderBy: { dueAt: "asc" },
    include: { lead: true },
  });
  if (due && due.lead.status !== "DNC" && due.lead.status !== "BLOCKED") {
    const e = await eligibility(campaign, plans, due.lead, now);
    if (e.decision.allowed) {
      await prisma.$transaction([
        prisma.callback.update({ where: { id: due.id }, data: { status: "OFFERED" } }),
        prisma.lead.update({ where: { id: due.lead.id }, data: { status: "DIALING", ownerId: agentId } }),
      ]);
      return { lead: due.lead, plan: e.plan };
    }
  }

  // 2. Fresh / recycled leads from the campaign's active lists.
  const order = campaign.hopperOrder === "FIFO" ? ("asc" as const) : ("desc" as const);
  const candidates = await prisma.lead.findMany({
    where: {
      list: { campaignId: campaign.id, status: "ACTIVE" },
      status: { in: ["NEW", "CONTACTED", "CALLBACK"] },
      scrubStatus: { notIn: ["DNC", "LITIGATOR"] },
      timezone: { not: null },
      OR: [{ nextDialAt: null }, { nextDialAt: { lte: now } }],
      AND: [{ OR: [{ ownerId: null }, { ownerId: agentId }] }],
    },
    orderBy: [{ postedAt: order }],
    take: 40,
  });

  let lastReason = "No leads are waiting in this campaign's lists";
  for (const lead of candidates) {
    const e = await eligibility(campaign, plans, lead, now);
    if (!e.decision.allowed) {
      lastReason = e.decision.reason;
      // Park it so the next scan does not re-check the same refusal.
      await prisma.lead.update({ where: { id: lead.id }, data: { nextDialAt: new Date(now.getTime() + 30 * 60_000) } }).catch(() => undefined);
      continue;
    }
    const reserved = await prisma.lead.updateMany({
      where: { id: lead.id, status: lead.status, ownerId: lead.ownerId },
      data: { status: "DIALING", ownerId: agentId },
    });
    if (reserved.count === 1) return { lead, plan: e.plan };
  }
  return { lead: null, reason: candidates.length ? `Nothing dialable right now: ${lastReason}` : lastReason };
}

/** Put a reserved lead back without dialing it (agent skipped or logged out). */
export async function releaseLead(leadId: string, delayMinutes = 60): Promise<void> {
  await prisma.lead.updateMany({
    where: { id: leadId, status: "DIALING" },
    data: { status: "NEW", ownerId: null, nextDialAt: new Date(Date.now() + delayMinutes * 60_000) },
  });
}
