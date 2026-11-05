// Billing (owner, 5 Nov): prepaid per client. Everything billable lands in
// BillingEntry as it happens and moves the account balance; the platform
// workspace records payments by hand (no cards yet). Below zero for longer
// than the grace period, outbound stops until a payment arrives.
import { prisma, type BillingCategory } from "@strowger/db";
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
  await prisma.$transaction([
    prisma.billingEntry.create({ data: { tenantId, kind: amountCents > 0 ? "PAYMENT" : "ADJUSTMENT", category: amountCents > 0 ? "PAYMENT" : "OTHER", quantity: 1, unitMillicents: amountCents * 1000, amountCents, note, period: period(), createdById } }),
    prisma.billingAccount.update({ where: { tenantId }, data: { balanceCents: { increment: amountCents } } }),
  ]);
  await afterBalanceChange(tenantId);
}

/** Lift a suspension once the balance is back above zero; start the clock when it drops to zero. */
async function afterBalanceChange(tenantId: string): Promise<void> {
  const a = await prisma.billingAccount.findUnique({ where: { tenantId } });
  if (!a) return;
  if (a.balanceCents > 0 && (a.suspended || a.zeroSince)) {
    await prisma.billingAccount.update({ where: { tenantId }, data: { suspended: false, suspendedAt: null, zeroSince: null } });
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
    await prisma.billingAccount.update({ where: { id: a.id }, data: { suspended: true, suspendedAt: now } });
    emitToTenant(a.tenantId, "billing:update", { suspended: true, balanceCents: a.balanceCents });
    log.warn({ tenantId: a.tenantId }, "billing: outbound suspended, balance exhausted past grace");
  }
}

/** Outbound allowed? Platform workspace is never billed. */
export async function outboundAllowed(tenantId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true, billing: { select: { suspended: true, balanceCents: true, zeroSince: true } } } });
  if (!t || t.isPlatform) return { ok: true };
  if (t.billing?.suspended) return { ok: false, error: "Outbound is paused: the prepaid balance is used up. Add a payment to continue." };
  // Never funded: a workspace someone signed up for, or a client whose first payment has not been recorded. Grace only applies after a balance has run down.
  if (!t.billing || (t.billing.balanceCents <= 0 && !t.billing.zeroSince)) return { ok: false, error: "No prepaid balance on this workspace yet. Ask your account manager to record a payment." };
  return { ok: true };
}

// ---- The billable things

/** First login of the month by an agent = a seat. Admins and managers are free. */
export async function chargeSeatIfNew(tenantId: string, userId: string): Promise<void> {
  const [t, u, a] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } }), prisma.user.findUnique({ where: { id: userId }, select: { roles: true, firstName: true, email: true } }), ensureAccount(tenantId)]);
  if (!t || t.isPlatform || !u) return;
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
  await charge({ tenantId: call.tenantId, category: "MINUTES", quantity: minutes, unitMillicents: a.perMinuteMillicents, costCents: Math.round((minutes * costPerMin) / 1000), note: `${call.direction === "INBOUND" ? "Inbound" : "Outbound"} call, ${Math.round(seconds)} s`, refId: callId });
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
  const [t, a] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatform: true } }), ensureAccount(tenantId)]);
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
    graceDays: a.graceDays,
    zeroSince: a.zeroSince?.toISOString() ?? null,
    dailyAvgCents: Math.round(dailyAvg),
    runwayDays,
    rates: { seatMonthlyCents: a.seatMonthlyCents, perMinuteMillicents: a.perMinuteMillicents, didMarkupPct: a.didMarkupPct, scrubMarginMillicents: a.scrubMarginMillicents, smsPriceMillicents: a.smsPriceMillicents },
  };
}

export async function billingOverview(tenantId: string, p = period()) {
  const [status, byCat, entries, r, months] = await Promise.all([
    billingStatus(tenantId),
    prisma.billingEntry.groupBy({ by: ["category"], where: { tenantId, period: p, kind: "CHARGE" }, _sum: { amountCents: true, quantity: true, costCents: true } }),
    prisma.billingEntry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100 }),
    rates(),
    prisma.billingEntry.groupBy({ by: ["period"], where: { tenantId, kind: "CHARGE" }, _sum: { amountCents: true } }),
  ]);
  return {
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
