// Number planning and the pool (owner, 6 Nov). A campaign's leads say which
// area codes it calls and how hard; shared/did-plan.ts turns that into numbers
// per area code; this file loads the inputs, and applies a plan: pool numbers
// are pinned to the campaign, the rest are searched and ordered at Telnyx
// (pinned to the campaign too). Numbers come back to the pool when a campaign
// is archived or a number is flagged; rested numbers rotate back in from the
// pool; pool numbers idle for two weeks are surfaced on /numbers, never
// released by themselves.
import { prisma, Prisma } from "@strowger/db";
import { stateForAreaCode } from "@strowger/shared";
import { PLAN_DEFAULTS, isIdlePoolNumber, planDids, type DidPlan, type PlanNumber, type PlanOptions } from "@strowger/shared/did-plan";
import { ensureAccount, outboundAllowed, rates } from "../billing";
import { log } from "../log";
import { orderNumbers, searchNumbers } from "./index";

const DIALABLE = ["NEW", "IN_HOPPER", "DIALING", "CONTACTED", "CALLBACK"];

export interface PlanView {
  plan: DidPlan;
  campaign: { id: string; name: string; callerIdMode: string; callerIdFallback: string; status: string };
  list: { id: string; name: string } | null;
  /** Lists whose leads the plan counts. */
  lists: number;
  /** Pinned numbers that still wait for the Free Caller Registry. */
  unregistered: number;
  notes: string[];
}

/** Numbers that can take dials (or will once registered): ACTIVE, not resting, not failed or released. */
function usable(now: Date) {
  return { status: "ACTIVE" as const, provisionStatus: { notIn: ["failed", "released"] }, OR: [{ restUntil: null }, { restUntil: { lte: now } }] };
}

const asPlan = (n: { id: string; phone: string; areaCode: string; state: string | null }): PlanNumber => ({ id: n.id, phone: n.phone, areaCode: n.areaCode, state: n.state ?? stateForAreaCode(n.areaCode) });

export async function loadDidPlan(tenantId: string, campaignId: string, opts: PlanOptions & { listId?: string | null } = {}): Promise<PlanView> {
  const now = new Date();
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    include: { dialPlans: { where: { active: true }, select: { attemptsPerDay: true } }, lists: { select: { id: true, name: true, status: true, cadence: { select: { maxAttemptsPerDay: true } } } } },
  });
  if (!campaign) throw new Error("Unknown campaign");
  const notes: string[] = [];
  let lists = campaign.lists.filter((l) => l.status === "ACTIVE");
  let list: PlanView["list"] = null;
  if (opts.listId) {
    const l = await prisma.list.findFirst({ where: { id: opts.listId, tenantId }, select: { id: true, name: true, status: true, campaignId: true, cadence: { select: { maxAttemptsPerDay: true } } } });
    if (!l) throw new Error("Unknown list");
    if (l.campaignId !== campaignId) throw new Error("This list is not in that campaign");
    list = { id: l.id, name: l.name };
    lists = [l];
  }
  const cadenceMax = Math.max(0, ...lists.map((l) => l.cadence?.maxAttemptsPerDay ?? 0));
  const attemptRule = Math.max(campaign.maxAttemptsPerDay, ...campaign.dialPlans.map((p) => p.attemptsPerDay), cadenceMax);

  const listIds = lists.map((l) => l.id);
  const counts = listIds.length
    ? await prisma.$queryRaw<{ ac: string; n: number }[]>`
        SELECT substring("phone" from 1 for 3) AS ac, count(*)::int AS n
        FROM "Lead"
        WHERE "tenantId" = ${tenantId} AND "listId" IN (${Prisma.join(listIds)})
          AND "status"::text IN (${Prisma.join(DIALABLE)}) AND "scrubStatus"::text NOT IN ('DNC', 'LITIGATOR')
        GROUP BY 1`
    : [];

  const [have, pool, unregistered, tenant, account, r] = await Promise.all([
    prisma.callerIdNumber.findMany({ where: { tenantId, campaignId, ...usable(now) }, select: { id: true, phone: true, areaCode: true, state: true } }),
    prisma.callerIdNumber.findMany({ where: { tenantId, campaignId: null, ...usable(now) }, select: { id: true, phone: true, areaCode: true, state: true } }),
    prisma.callerIdNumber.count({ where: { tenantId, campaignId, ...usable(now), registeredAt: null } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } }),
    ensureAccount(tenantId),
    rates(),
  ]);
  const priceCents = tenant?.isPlatform ? r.didMonthlyCents : Math.round(r.didMonthlyCents * (1 + account.didMarkupPct / 100));

  // A campaign that dials exact area codes only cannot use same-state stand-ins.
  const exactOnly = campaign.callerIdFallback === "EXACT_ONLY" ? true : opts.exactOnly;
  if (campaign.callerIdFallback === "EXACT_ONLY" && !opts.exactOnly) notes.push("This campaign dials exact area codes only (Caller ID card), so same-state numbers cannot stand in.");
  const plan = planDids({
    leads: counts.map((c) => ({ areaCode: c.ac, state: stateForAreaCode(c.ac), leads: Number(c.n) })),
    have: have.map(asPlan),
    pool: pool.map(asPlan),
    attemptRule,
    priceCents,
    poolFirst: opts.poolFirst,
    exactOnly,
  });

  if (campaign.callerIdMode === "FIXED") notes.push("This campaign shows one fixed number; switch Caller ID to local presence for these numbers to be used.");
  if (list && campaign.lists.filter((l) => l.status === "ACTIVE" && l.id !== list.id).length) notes.push("This plan counts this list's leads against every number the campaign has; the campaign page plans for all its lists together.");
  if (unregistered) notes.push(`${unregistered} of the campaign's numbers still wait for the Free Caller Registry (DIDs page) and will not dial until registered.`);
  if (tenant?.isPlatform) notes.push("Platform workspace: numbers are not billed; the price shown is our cost.");
  return { plan, campaign: { id: campaign.id, name: campaign.name, callerIdMode: campaign.callerIdMode, callerIdFallback: campaign.callerIdFallback, status: campaign.status }, list, lists: lists.length, unregistered, notes };
}

export interface ApplyResult {
  taken: { phone: string; areaCode: string; forAreaCode: string }[];
  ordered: { areaCode: string; requested: string; phones: string[] }[];
  short: { areaCode: string; count: number; reason: string }[];
  error?: string;
}

/** Pin the plan's pool numbers to the campaign, then order what is still short (same-state numbers where Telnyx has none in the area code). */
export async function applyDidPlan(input: { tenantId: string; campaignId: string; userId: string; listId?: string | null; requestedBy?: string } & PlanOptions): Promise<ApplyResult> {
  const { tenantId, campaignId } = input;
  const view = await loadDidPlan(tenantId, campaignId, input);
  if (view.campaign.status === "ARCHIVED") throw new Error("This campaign is archived; its numbers belong to the pool");
  const out: ApplyResult = { taken: [], ordered: [], short: [] };

  for (const t of view.plan.take) {
    const r = await prisma.callerIdNumber.updateMany({ where: { id: t.id, tenantId, campaignId: null, status: "ACTIVE" }, data: { campaignId } });
    if (r.count === 1) out.taken.push({ phone: t.phone, areaCode: t.phone.slice(0, 3), forAreaCode: t.forAreaCode });
  }
  // A pool number taken by someone else in the meantime is ordered instead.
  const lost = new Map<string, number>();
  for (const t of view.plan.take) if (!out.taken.some((x) => x.phone === t.phone)) lost.set(t.forAreaCode, (lost.get(t.forAreaCode) ?? 0) + 1);
  const order = view.plan.order.map((o) => ({ ...o, count: o.count + (lost.get(o.areaCode) ?? 0) }));
  for (const [ac, n] of lost) if (!order.some((o) => o.areaCode === ac)) order.push({ areaCode: ac, state: stateForAreaCode(ac), count: n });

  if (order.length) {
    const allowed = await outboundAllowed(tenantId);
    if (!allowed.ok) {
      out.error = `Nothing ordered: ${allowed.error}`;
      for (const o of order) out.short.push({ areaCode: o.areaCode, count: o.count, reason: "billing" });
    } else {
      for (const o of order) {
        try {
          let found = (await searchNumbers({ areaCode: o.areaCode, limit: Math.min(100, o.count) })).map((f) => f.phone);
          let substitute: string[] = [];
          if (found.length < o.count && o.state) {
            const more = await searchNumbers({ state: o.state, limit: Math.min(100, o.count - found.length + 5) }).catch(() => []);
            substitute = more
              .map((f) => f.phone)
              .filter((p) => !found.includes(p))
              .slice(0, o.count - found.length);
          }
          found = found.slice(0, o.count);
          for (const [phones, requested] of [
            [found, o.areaCode],
            [substitute, o.areaCode],
          ] as const) {
            for (let i = 0; i < phones.length; i += 50) {
              const chunk = phones.slice(i, i + 50);
              const ac = chunk[0]!.slice(0, 3);
              const r = await orderNumbers({ tenantId, phones: [...chunk], campaignId, areaCode: ac, requestedBy: input.requestedBy });
              out.ordered.push({ areaCode: ac, requested, phones: r.numbers.map((n) => n.phone) });
            }
          }
          const got = found.length + substitute.length;
          if (substitute.length) out.short.push({ areaCode: o.areaCode, count: substitute.length, reason: `Telnyx had ${found.length} in ${o.areaCode}; ${substitute.length} ordered elsewhere in ${o.state}` });
          if (got < o.count) out.short.push({ areaCode: o.areaCode, count: o.count - got, reason: `Telnyx has no more numbers in ${o.areaCode}${o.state ? ` or ${o.state}` : ""} right now` });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn({ err: msg, areaCode: o.areaCode }, "did plan: order failed");
          out.short.push({ areaCode: o.areaCode, count: o.count, reason: msg });
          out.error ??= msg;
        }
      }
    }
  }

  await prisma.auditLog
    .create({
      data: {
        tenantId,
        actorId: input.userId,
        action: "numbers.plan.apply",
        target: campaignId,
        after: {
          listId: input.listId ?? null,
          poolFirst: view.plan.assumptions.poolFirst,
          exactOnly: view.plan.assumptions.exactOnly,
          taken: out.taken.map((t) => t.phone),
          ordered: out.ordered.map((o) => ({ areaCode: o.areaCode, count: o.phones.length })),
          short: out.short,
        } as Prisma.InputJsonValue,
      },
    })
    .catch((e) => log.warn({ err: e, campaignId }, "did plan: audit log failed"));
  return out;
}

/** Rested and flagged numbers whose rest is over go back into rotation from the pool. */
export async function restoreRestedNumbers(now = new Date()): Promise<number> {
  const r = await prisma.callerIdNumber.updateMany({ where: { status: { in: ["RESTING", "SPAM_FLAGGED"] }, restUntil: { lte: now } }, data: { status: "ACTIVE", restUntil: null, campaignId: null } });
  if (r.count) log.info({ count: r.count }, "rested numbers back in the pool");
  return r.count;
}

/** Pool numbers with no use in two weeks, per workspace (shown on /numbers; never released automatically). */
export async function idlePoolNumbers(tenantId?: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - PLAN_DEFAULTS.idleDays * 86_400_000);
  const rows = await prisma.callerIdNumber.findMany({
    where: { ...(tenantId ? { tenantId } : {}), campaignId: null, status: { not: "RETIRED" }, provisionStatus: { not: "released" }, OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }] },
    select: { id: true, tenantId: true, phone: true, areaCode: true, status: true, campaignId: true, lastUsedAt: true, createdAt: true, telnyxNumberId: true },
    orderBy: [{ lastUsedAt: "asc" }, { createdAt: "asc" }],
  });
  return rows.filter((n) => isIdlePoolNumber(n, now));
}

/** Daily: say how many pool numbers sit idle, per workspace. The decision to release is a person's. */
export async function idlePoolCheck(): Promise<void> {
  const idle = await idlePoolNumbers();
  const by = new Map<string, number>();
  for (const n of idle) by.set(n.tenantId, (by.get(n.tenantId) ?? 0) + 1);
  for (const [tenantId, count] of by) log.info({ tenantId, count }, `pool: ${count} number(s) idle ${PLAN_DEFAULTS.idleDays}+ days; review on /numbers`);
}
