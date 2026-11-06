// Billing (owner, 5 Nov): prepaid per client. Everything billable lands in
// BillingEntry as it happens and moves the account balance; the platform
// workspace records payments by hand (no cards yet). Below zero for longer
// than the grace period, outbound stops until a payment arrives.
import { prisma, type BillingCategory, type BillingKind, type Prisma } from "@strowger/db";
import { inTrial } from "@strowger/shared/referrals";
import { log } from "../log";
import { emitToTenant } from "../realtime";

export const period = (d = new Date()) => d.toISOString().slice(0, 7);
const MANAGER_ROLES = ["ADMIN", "SUPERVISOR", "ROOM_SUPERVISOR"] as const;

export async function ensureAccount(tenantId: string) {
  return prisma.billingAccount.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
}

export async function rates() {
  return prisma.platformRates.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

interface ChargeInput {
  tenantId: string;
  category: BillingCategory;
  quantity: number;
  unitMillicents: number;
  costCents?: number;
  note?: string;
  refId?: string;
  createdById?: string;
}

/** A charge: negative on the ledger, balance down. Amount is rounded to the cent per entry. */
export async function charge(input: ChargeInput): Promise<number> {
  const amountCents = Math.round((input.quantity * input.unitMillicents) / 1000);
  if (amountCents <= 0) return 0;
  await ensureAccount(input.tenantId);
  await prisma.$transaction([
    prisma.billingEntry.create({ data: { tenantId: input.tenantId, kind: "CHARGE", category: input.category, quantity: input.quantity, unitMillicents: input.unitMillicents, amountCents: -amountCents, costCents: input.costCents ?? 0, note: input.note, refId: input.refId, period: period(), createdById: input.createdById } }),
    prisma.billingAccount.update({ where: { tenantId: input.tenantId }, data: { balanceCents: { decrement: amountCents } } }),
  ]);
  void afterBalanceChange(input.tenantId);
  return amountCents;
}

export async function recordPayment(tenantId: string, amountCents: number, note: string, createdById: string): Promise<void> {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error("Amount must be a whole number of cents");
  await ensureAccount(tenantId);
  const now = new Date();
  await prisma.$transaction([
    prisma.billingEntry.create({ data: { tenantId, kind: amountCents > 0 ? "PAYMENT" : "ADJUSTMENT", category: amountCents > 0 ? "PAYMENT" : "OTHER", quantity: 1, unitMillicents: amountCents * 1000, amountCents, note, period: period(), createdById } }),
    prisma.billingAccount.update({ where: { tenantId }, data: { balanceCents: { increment: amountCents } } }),
    // The first real payment ends the trial's limits and locks who referred this client.
    ...(amountCents > 0
      ? [
          prisma.tenant.updateMany({ where: { id: tenantId, trialEndsAt: { not: null }, trialConvertedAt: null }, data: { trialConvertedAt: now } }),
          prisma.referral.updateMany({ where: { referredTenantId: tenantId, lockedAt: null }, data: { lockedAt: now } }),
        ]
      : []),
  ]);
  await afterBalanceChange(tenantId, { payment: amountCents > 0 });
}

/**
 * One ledger line that is not a usage charge (trial allowance, referral
 * credit or clawback), with the balance moved in the same transaction. A
 * `uniqueKey` makes it idempotent: a second post with the same key is a no-op.
 */
export async function postEntry(input: { tenantId: string; kind: BillingKind; category: BillingCategory; amountCents: number; note: string; refId?: string | null; uniqueKey?: string | null; createdById?: string | null }, tx?: Prisma.TransactionClient): Promise<boolean> {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) return false;
  const write = async (db: Prisma.TransactionClient) => {
    if (input.uniqueKey && (await db.billingEntry.findUnique({ where: { uniqueKey: input.uniqueKey } }))) return false;
    await db.billingAccount.upsert({ where: { tenantId: input.tenantId }, create: { tenantId: input.tenantId }, update: {} });
    await db.billingEntry.create({ data: { tenantId: input.tenantId, kind: input.kind, category: input.category, quantity: 1, unitMillicents: input.amountCents * 1000, amountCents: input.amountCents, note: input.note, refId: input.refId ?? null, uniqueKey: input.uniqueKey ?? null, period: period(), createdById: input.createdById ?? null } });
    await db.billingAccount.update({ where: { tenantId: input.tenantId }, data: { balanceCents: { increment: input.amountCents } } });
    return true;
  };
  const done = tx ? await write(tx) : await prisma.$transaction((t) => write(t));
  if (done && !tx) await afterBalanceChange(input.tenantId);
  return done;
}

/**
 * Lift a suspension once the balance is back above zero; start the clock
 * when it drops to zero. A trial that ended unpaid is lifted only by a
 * payment, never by a credit landing on the account.
 */
export async function afterBalanceChange(tenantId: string, opts: { payment?: boolean } = {}): Promise<void> {
  const a = await prisma.billingAccount.findUnique({ where: { tenantId } });
  if (!a) return;
  if (a.balanceCents > 0 && (a.suspended || a.zeroSince) && (a.suspendReason !== "TRIAL_ENDED" || opts.payment)) {
    await prisma.billingAccount.update({ where: { tenantId }, data: { suspended: false, suspendedAt: null, suspendReason: null, zeroSince: null } });
    emitToTenant(tenantId, "billing:update", { suspended: false, balanceCents: a.balanceCents });
  } else if (a.balanceCents <= 0 && !a.zeroSince) {
    await prisma.billingAccount.update({ where: { tenantId }, data: { zeroSince: new Date() } });
  }
  emitToTenant(tenantId, "billing:update", { balanceCents: a.balanceCents, suspended: a.suspended });
}

/** Hourly: suspend accounts that have been at or below zero for longer than their grace period. */
export async function suspendOverdue(now = new Date()): Promise<void> {
  const due = await prisma.billingAccount.findMany({ where: { suspended: false, balanceCents: { lte: 0 }, zeroSince: { not: null } } });
  for (const a of due) {
    if (now.getTime() - a.zeroSince!.getTime() < a.graceDays * 86_400_000) continue;
    await prisma.billingAccount.update({ where: { id: a.id }, data: { suspended: true, suspendedAt: now, suspendReason: "BALANCE" } });
    emitToTenant(a.tenantId, "billing:update", { suspended: true, balanceCents: a.balanceCents });
    log.warn({ tenantId: a.tenantId }, "billing: outbound suspended, balance exhausted past grace");
  }
}

export const TRIAL_ENDED_MESSAGE = "Your trial ended: add a prepayment to keep dialing.";

/** Outbound allowed? Platform workspace is never billed. */
export async function outboundAllowed(tenantId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true, closedAt: true, trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, billing: { select: { suspended: true, suspendReason: true, balanceCents: true, zeroSince: true } } } });
  if (!t || t.isPlatform) return { ok: true };
  if (t.closedAt) return { ok: false, error: "This workspace is closed." };
  if (t.billing?.suspended) return { ok: false, error: t.billing.suspendReason === "TRIAL_ENDED" ? TRIAL_ENDED_MESSAGE : "Outbound is paused: the prepaid balance is used up. Add a payment to continue." };
  // The trial dials within its allowance, with no grace period after it.
  if (inTrial(t, new Date()) && (t.billing?.balanceCents ?? 0) <= 0) return { ok: false, error: "Your free trial allowance is used up: add a prepayment to keep dialing." };
  // Never funded: a workspace someone signed up for, or a client whose first payment has not been recorded. Grace only applies after a balance has run down.
  if (!t.billing || (t.billing.balanceCents <= 0 && !t.billing.zeroSince)) return { ok: false, error: "No prepaid balance on this workspace yet. Ask your account manager to record a payment." };
  return { ok: true };
}

// ---- The billable things

/** The free trial's limits while it runs, else null. */
export async function activeTrial(tenantId: string, now = new Date()): Promise<{ endsAt: Date; startedAt: Date; seats: number; maxNumbers: number } | null> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, trialSeats: true, trialMaxNumbers: true } });
  if (!t || !inTrial(t, now)) return null;
  return { endsAt: t.trialEndsAt!, startedAt: t.trialStartedAt ?? t.trialEndsAt!, seats: t.trialSeats ?? 5, maxNumbers: t.trialMaxNumbers ?? 3 };
}

/** During the trial at most `seats` different agents may log in; a refusal message, else null. */
export async function trialSeatRefusal(tenantId: string, userId: string): Promise<string | null> {
  const trial = await activeTrial(tenantId);
  if (!trial) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });
  if (!u || u.roles.some((r) => (MANAGER_ROLES as readonly string[]).includes(r))) return null;
  const sessions = await prisma.agentSession.findMany({ where: { tenantId, startedAt: { gte: trial.startedAt } }, select: { userId: true }, distinct: ["userId"] });
  const ids = new Set(sessions.map((x) => x.userId));
  if (ids.has(userId)) return null;
  const people = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, roles: true } });
  const seats = people.filter((m) => !m.roles.some((r) => (MANAGER_ROLES as readonly string[]).includes(r))).length;
  return seats >= trial.seats ? `The free trial includes ${trial.seats} agent seats and all ${trial.seats} are in use. Add a prepayment to add more.` : null;
}

/** First login of the month by an agent = a seat. Admins and managers are free, and so are seats during the free trial. */
export async function chargeSeatIfNew(tenantId: string, userId: string): Promise<void> {
  const [t, u, a] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } }), prisma.user.findUnique({ where: { id: userId }, select: { roles: true, firstName: true, email: true } }), ensureAccount(tenantId)]);
  if (!t || t.isPlatform || !u) return;
  if (await activeTrial(tenantId)) return;
  if (u.roles.some((r) => (MANAGER_ROLES as readonly string[]).includes(r))) return;
  const p = period();
  const existing = await prisma.billingEntry.findFirst({ where: { tenantId, category: "SEAT", period: p, refId: userId } });
  if (existing) return;
  await charge({ tenantId, category: "SEAT", quantity: 1, unitMillicents: a.seatMonthlyCents * 1000, note: `Seat ${p}: ${u.firstName ?? u.email}`, refId: userId });
}

/** Talk time on a call, by the second at the per-minute rate; our cost from the platform rates. */
export async function chargeCallMinutes(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { tenantId: true, direction: true, answeredAt: true, endedAt: true } });
  if (!call?.answeredAt || !call.endedAt) return;
  const t = await prisma.tenant.findUnique({ where: { id: call.tenantId }, select: { isPlatform: true } });
  if (!t || t.isPlatform) return;
  const seconds = Math.max(0, (call.endedAt.getTime() - call.answeredAt.getTime()) / 1000);
  if (seconds < 1) return;
  const minutes = Math.round((seconds / 60) * 10000) / 10000;
  const [a, r] = await Promise.all([ensureAccount(call.tenantId), rates()]);
  const costPerMin = call.direction === "INBOUND" ? r.telnyxInMillicentsPerMin : r.telnyxOutMillicentsPerMin;
  await charge({ tenantId: call.tenantId, category: "MINUTES", quantity: minutes, unitMillicents: a.perMinuteMillicents, costCents: Math.round((minutes * costPerMin) / 1000), note: `${call.direction === "INBOUND" ? "Inbound" : call.direction === "TRANSFER" ? "Transfer leg" : "Outbound"} call, ${Math.round(seconds)} s`, refId: callId });
}

/** A number's monthly fee: our cost plus the markup. Once per number per month. */
export async function chargeDidMonthly(tenantId: string, numberId: string, phone: string): Promise<void> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } });
  if (!t || t.isPlatform) return;
  const p = period();
  if (await prisma.billingEntry.findFirst({ where: { tenantId, category: "DID", period: p, refId: numberId } })) return;
  const [a, r] = await Promise.all([ensureAccount(tenantId), rates()]);
  const price = Math.round(r.didMonthlyCents * (1 + a.didMarkupPct / 100));
  await charge({ tenantId, category: "DID", quantity: 1, unitMillicents: price * 1000, costCents: r.didMonthlyCents, note: `Number ${phone}, ${p}`, refId: numberId });
}

/** First of the month: every active number on every billed workspace. */
export async function chargeAllDids(): Promise<void> {
  const numbers = await prisma.callerIdNumber.findMany({ where: { status: { not: "RETIRED" }, provisionStatus: { in: ["ready", "voice", "ordered"] } }, select: { id: true, tenantId: true, phone: true } });
  for (const n of numbers) await chargeDidMonthly(n.tenantId, n.id, n.phone).catch((e) => log.warn({ err: e }, "did charge failed"));
}

export async function chargeScrub(tenantId: string, records: number): Promise<void> {
  if (records <= 0) return;
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } });
  if (!t || t.isPlatform) return;
  const [a, r] = await Promise.all([ensureAccount(tenantId), rates()]);
  await charge({ tenantId, category: "SCRUB", quantity: records, unitMillicents: r.scrubCostMillicents + a.scrubMarginMillicents, costCents: Math.round((records * r.scrubCostMillicents) / 1000), note: `Litigator / DNC scrub, ${records} records` });
}

export async function chargeSms(tenantId: string, messageId: string, segments = 1): Promise<void> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } });
  if (!t || t.isPlatform) return;
  const [a, r] = await Promise.all([ensureAccount(tenantId), rates()]);
  await charge({ tenantId, category: "SMS", quantity: segments, unitMillicents: a.smsPriceMillicents, costCents: Math.round((segments * r.smsCostMillicents) / 1000), note: "Text message", refId: messageId });
}

// ---- Views

export async function billingStatus(tenantId: string) {
  const [t, a] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true, trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, trialAllowanceCents: true, trialSeats: true, trialMaxNumbers: true, trialReminderAt: true } }), ensureAccount(tenantId)]);
  const now = new Date();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const spend = await prisma.billingEntry.aggregate({ where: { tenantId, kind: "CHARGE", createdAt: { gte: since } }, _sum: { amountCents: true } });
  const spent30 = -(spend._sum.amountCents ?? 0);
  const dailyAvg = spent30 / 30;
  const runwayDays = dailyAvg > 0 ? Math.floor(Math.max(0, a.balanceCents) / dailyAvg) : null;
  return {
    isPlatform: Boolean(t?.isPlatform),
    balanceCents: a.balanceCents,
    lowBalanceCents: a.lowBalanceCents,
    low: !t?.isPlatform && a.balanceCents <= a.lowBalanceCents,
    critical: !t?.isPlatform && a.balanceCents <= 0,
    suspended: a.suspended,
    suspendReason: a.suspendReason,
    trial: t?.trialEndsAt
      ? { active: inTrial(t, now), endsAt: t.trialEndsAt.toISOString(), startedAt: t.trialStartedAt?.toISOString() ?? null, convertedAt: t.trialConvertedAt?.toISOString() ?? null, reminderAt: t.trialReminderAt?.toISOString() ?? null, allowanceCents: t.trialAllowanceCents ?? 0, seats: t.trialSeats ?? 0, maxNumbers: t.trialMaxNumbers ?? 0 }
      : null,
    graceDays: a.graceDays,
    zeroSince: a.zeroSince?.toISOString() ?? null,
    dailyAvgCents: Math.round(dailyAvg),
    runwayDays,
    rates: { seatMonthlyCents: a.seatMonthlyCents, perMinuteMillicents: a.perMinuteMillicents, didMarkupPct: a.didMarkupPct, scrubMarginMillicents: a.scrubMarginMillicents, smsPriceMillicents: a.smsPriceMillicents },
  };
}

export async function billingOverview(tenantId: string, p = period()) {
  const [status, byCat, entries, r, months, referral] = await Promise.all([
    billingStatus(tenantId),
    prisma.billingEntry.groupBy({ by: ["category"], where: { tenantId, period: p, kind: "CHARGE" }, _sum: { amountCents: true, quantity: true, costCents: true } }),
    prisma.billingEntry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 }),
    rates(),
    prisma.billingEntry.groupBy({ by: ["period"], where: { tenantId, kind: "CHARGE" }, _sum: { amountCents: true } }),
    prisma.billingEntry.aggregate({ where: { tenantId, period: p, kind: { in: ["REFERRAL_CREDIT", "REFERRAL_CLAWBACK"] } }, _sum: { amountCents: true } }),
  ]);
  return {
    referralCreditsCents: referral._sum.amountCents ?? 0,
    period: p,
    status,
    categories: byCat.map((c) => ({ category: c.category, amountCents: -(c._sum.amountCents ?? 0), quantity: Number(c._sum.quantity ?? 0), costCents: c._sum.costCents ?? 0 })),
    entries: entries.map((e) => ({ id: e.id, kind: e.kind, category: e.category, quantity: Number(e.quantity), unitMillicents: e.unitMillicents, amountCents: e.amountCents, note: e.note, at: e.createdAt.toISOString(), period: e.period })),
    statements: months.map((m) => ({ period: m.period, amountCents: -(m._sum.amountCents ?? 0) })).sort((x, y) => (x.period < y.period ? 1 : -1)),
    prepayInstructions: r.prepayInstructions,
  };
}

/** The owner's view: every client with balance, month to date, cost, margin. */
export async function platformOverview(p = period()) {
  const tenants = await prisma.tenant.findMany({ where: { isPlatform: false }, select: { id: true, name: true, slug: true, billing: true, _count: { select: { users: true } } }, orderBy: { name: "asc" } });
  const sums = await prisma.billingEntry.groupBy({ by: ["tenantId"], where: { period: p, kind: "CHARGE" }, _sum: { amountCents: true, costCents: true } });
  const seats = await prisma.billingEntry.groupBy({ by: ["tenantId"], where: { period: p, category: "SEAT" }, _count: { _all: true } });
  const r = await rates();
  return {
    period: p,
    rates: r,
    tenants: tenants.map((t) => {
      const s = sums.find((x) => x.tenantId === t.id);
      const seat = seats.find((x) => x.tenantId === t.id);
      const revenue = -(s?._sum.amountCents ?? 0);
      const cost = s?._sum.costCents ?? 0;
      return { id: t.id, name: t.name, slug: t.slug, users: t._count.users, seats: seat?._count._all ?? 0, balanceCents: t.billing?.balanceCents ?? 0, suspended: t.billing?.suspended ?? false, lowBalanceCents: t.billing?.lowBalanceCents ?? 20000, revenueCents: revenue, costCents: cost, marginCents: revenue - cost, plan: t.billing ? { seatMonthlyCents: t.billing.seatMonthlyCents, perMinuteMillicents: t.billing.perMinuteMillicents, didMarkupPct: t.billing.didMarkupPct, scrubMarginMillicents: t.billing.scrubMarginMillicents, smsPriceMillicents: t.billing.smsPriceMillicents, lowBalanceCents: t.billing.lowBalanceCents, graceDays: t.billing.graceDays } : null };
    }),
  };
}
