// Referral program and free trial (owner, 6 Nov). The rules are pure in
// `@strowger/shared/referrals`; this gathers the ledger figures, writes the
// credits through the billing module, runs the trial clock, and creates a
// signed-up client's workspace with its trial and attribution. Credits are
// always account credit (a positive BillingEntry), never cash.
import { prisma, type Prisma } from "@strowger/db";
import {
  REFERRAL_DEFAULTS,
  TRIAL_TERMS_VERSION,
  businessKey,
  checkTrialEligible,
  clawbackNote,
  computeReferralMonth,
  inTrial,
  isSelfReferral,
  monthRange,
  normalizeReferralCode,
  periodOf,
  previousPeriod,
  referralNote,
  referralPct,
  referrerLapsed,
  trialLeftoverCents,
  trialOverAt,
  trialReminderDue,
  type ReferredMonth,
  type ReferrerMonth,
} from "@strowger/shared/referrals";
import { normalizePhone } from "@strowger/shared";
import { afterBalanceChange, ensureAccount, postEntry, rates, TRIAL_ENDED_MESSAGE } from "../billing";
import { log } from "../log";
import { emitToTenant } from "../realtime";

const NOT_MONEY = ["TRIAL_CREDIT", "REFERRAL_CREDIT", "REFERRAL_CLAWBACK"] as const;
const num = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? null : Number(d));

type TenantRow = { id: string; name: string; createdAt: Date; closedAt: Date | null; trialStartedAt: Date | null; trialEndsAt: Date | null; trialConvertedAt: Date | null; billing: { suspended: boolean; suspendedAt: Date | null } | null };
const TENANT_SELECT = { id: true, name: true, createdAt: true, closedAt: true, trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, referralPctOverride: true, billing: { select: { suspended: true, suspendedAt: true } } } as const;

async function sum(where: Prisma.BillingEntryWhereInput): Promise<number> {
  const r = await prisma.billingEntry.aggregate({ where, _sum: { amountCents: true } });
  return r._sum.amountCents ?? 0;
}

const suspendedAt = (t: TenantRow, end: Date) => Boolean(t.billing?.suspended && (!t.billing.suspendedAt || t.billing.suspendedAt < end));
const closedBy = (t: TenantRow, end: Date) => Boolean(t.closedAt && t.closedAt < end);

/** The referrer's side of a month: [start, end). */
export async function referrerFigures(t: TenantRow, start: Date, end: Date): Promise<ReferrerMonth> {
  const [payments, balanceAtEnd, seats] = await Promise.all([
    sum({ tenantId: t.id, kind: "PAYMENT", createdAt: { gte: start, lt: end } }),
    sum({ tenantId: t.id, createdAt: { lt: end } }),
    prisma.billingEntry.count({ where: { tenantId: t.id, kind: "CHARGE", category: "SEAT", createdAt: { gte: start, lt: end } } }),
  ]);
  return { suspendedAtEnd: suspendedAt(t, end), closed: closedBy(t, end), paymentsCents: payments, balanceAtEndCents: balanceAtEnd, seatCharges: seats };
}

/** The referred client's side: charges after the trial, real money in, refunds, funded balance carried in. */
export async function referredFigures(t: TenantRow, start: Date, end: Date): Promise<ReferredMonth> {
  const over = trialOverAt(t);
  const from = over && over > start ? over : start;
  const [charges, payments, refunds, opening] = await Promise.all([
    from < end ? sum({ tenantId: t.id, kind: "CHARGE", createdAt: { gte: from, lt: end } }) : Promise.resolve(0),
    sum({ tenantId: t.id, kind: "PAYMENT", createdAt: { gte: start, lt: end } }),
    sum({ tenantId: t.id, kind: "ADJUSTMENT", amountCents: { lt: 0 }, createdAt: { gte: start, lt: end } }),
    sum({ tenantId: t.id, kind: { notIn: [...NOT_MONEY] }, createdAt: { lt: start } }),
  ]);
  return { suspendedAtEnd: suspendedAt(t, end), closed: closedBy(t, end), inTrialAtEnd: inTrial(t, new Date(end.getTime() - 1)), chargesCents: -charges, paymentsCents: payments, refundsCents: -refunds, openingFundedCents: opening };
}

async function priorBases(referralId: string, period: string) {
  const r = await prisma.referralPayout.aggregate({ where: { referralId, period: { lt: period } }, _sum: { clawbackBaseCents: true } });
  const credited = await prisma.referralPayout.aggregate({ where: { referralId, period: { lt: period }, status: "CREDIT" }, _sum: { baseCents: true } });
  return { priorBaseCents: credited._sum.baseCents ?? 0, priorClawedBaseCents: r._sum.clawbackBaseCents ?? 0 };
}

type ReferralWithTenants = Prisma.ReferralGetPayload<{ include: { tenant: { select: typeof TENANT_SELECT }; referred: { select: typeof TENANT_SELECT } } }>;

/** One relationship over [start, end) (end = now for this month's estimate). */
async function computeFor(ref: ReferralWithTenants, period: string, start: Date, end: Date, platformPct: number) {
  const pct = referralPct(platformPct, num(ref.tenant.referralPctOverride));
  const [referrer, referred, prior] = await Promise.all([referrerFigures(ref.tenant, start, end), referredFigures(ref.referred, start, end), priorBases(ref.id, period)]);
  const result = computeReferralMonth({ pct, endedBeforeMonthEnd: Boolean(ref.endedAt && ref.endedAt < end), referrer, referred, ...prior });
  return { pct, result };
}

const REF_INCLUDE = { tenant: { select: TENANT_SELECT }, referred: { select: TENANT_SELECT } } as const;

/**
 * Credit every relationship for a finished month. Idempotent: one
 * ReferralPayout per relationship and month (unique), and the ledger lines
 * carry `ref:<id>:<period>:credit|clawback` keys. Forfeited months are
 * recorded with their reason and a zero amount, never banked.
 */
export async function runReferralCredits(period: string, actorId: string | null = null, now = new Date()) {
  const { start, end } = monthRange(period);
  if (end > now) throw new Error(`${period} is not over yet; credits are worked out on the month after`);
  const r = await rates();
  const platformPct = Number(r.referralPct);
  const refs = await prisma.referral.findMany({ where: { createdAt: { lt: end } }, include: REF_INCLUDE });
  const out = { period, credited: 0, forfeited: 0, skipped: 0, creditCents: 0, clawbackCents: 0 };
  for (const ref of refs) {
    if (await prisma.referralPayout.findUnique({ where: { referralId_period: { referralId: ref.id, period } } })) {
      out.skipped++;
      continue;
    }
    const { pct, result } = await computeFor(ref, period, start, end, platformPct);
    // Long-ended relationships with nothing to claw back leave no row each month.
    if (ref.endedAt && ref.endedAt < start && result.clawbackCents === 0) continue;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.referralPayout.create({ data: { tenantId: ref.tenantId, referralId: ref.id, referredTenantId: ref.referredTenantId, period, status: result.status, pct, baseCents: result.baseCents, creditCents: result.creditCents, reason: result.reason, clawbackBaseCents: result.clawbackBaseCents, clawbackCents: result.clawbackCents, createdById: actorId } });
        if (result.creditCents > 0) await postEntry({ tenantId: ref.tenantId, kind: "REFERRAL_CREDIT", category: "REFERRAL", amountCents: result.creditCents, note: referralNote({ referredName: ref.referred.name, period, pct, baseCents: result.baseCents }), refId: ref.referredTenantId, uniqueKey: `ref:${ref.id}:${period}:credit`, createdById: actorId }, tx);
        if (result.clawbackCents > 0) await postEntry({ tenantId: ref.tenantId, kind: "REFERRAL_CLAWBACK", category: "REFERRAL", amountCents: -result.clawbackCents, note: clawbackNote({ referredName: ref.referred.name, period, pct, baseCents: result.clawbackBaseCents }), refId: ref.referredTenantId, uniqueKey: `ref:${ref.id}:${period}:clawback`, createdById: actorId }, tx);
      });
    } catch (e) {
      // Another run got there first (unique on referral + period).
      if ((e as { code?: string }).code === "P2002") {
        out.skipped++;
        continue;
      }
      throw e;
    }
    if (result.creditCents > 0 || result.clawbackCents > 0) await afterBalanceChange(ref.tenantId);
    if (result.status === "CREDIT") out.credited++;
    else out.forfeited++;
    out.creditCents += result.creditCents;
    out.clawbackCents += result.clawbackCents;
  }
  log.info(out, "referral credits run");
  return out;
}

/** Scheduler: the first tick of each month credits the month before. */
export async function monthlyReferralCredits(now = new Date()) {
  return runReferralCredits(previousPeriod(now), null, now);
}

/** Daily: a referrer with no payment and no usage for 60 days, or a closed workspace, loses every referral for good. */
export async function endLapsedReferrers(now = new Date()): Promise<number> {
  const referrers = await prisma.referral.groupBy({ by: ["tenantId"], where: { endedAt: null } });
  let ended = 0;
  for (const { tenantId } of referrers) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true, closedAt: true } });
    if (!t) continue;
    const last = await prisma.billingEntry.findFirst({ where: { tenantId, kind: { in: ["PAYMENT", "CHARGE"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const v = referrerLapsed({ lastActivityAt: last?.createdAt ?? null, createdAt: t.createdAt, closedAt: t.closedAt, now });
    if (!v.lapsed) continue;
    const r = await prisma.referral.updateMany({ where: { tenantId, endedAt: null }, data: { endedAt: now, endedReason: v.reason } });
    ended += r.count;
    await prisma.auditLog.create({ data: { tenantId, action: "referral.lapsed", after: { reason: v.reason, relationships: r.count } } });
  }
  return ended;
}

// ───────────────────────── Trial clock ─────────────────────────

/**
 * Hourly. Day 5: the reminder (in-app: the banner reads `trialReminderAt`;
 * there is no email path in Strowger yet). Trial over: the unused allowance
 * is removed, and a client that never paid is suspended through the billing
 * suspension with the "Your trial ended" message. Nothing is deleted.
 */
export async function trialTick(now = new Date()) {
  const open = await prisma.tenant.findMany({ where: { trialEndsAt: { not: null }, trialClosedAt: null }, select: { id: true, name: true, trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, trialReminderAt: true, trialAllowanceCents: true } });
  for (const t of open) {
    if (trialReminderDue(t, now)) {
      await prisma.tenant.update({ where: { id: t.id }, data: { trialReminderAt: now } });
      await prisma.auditLog.create({ data: { tenantId: t.id, action: "trial.reminder", after: { endsAt: t.trialEndsAt, channel: "in-app" } } });
      emitToTenant(t.id, "billing:update", { trialReminder: true });
    }
    if (t.trialEndsAt! > now) continue;
    const over = trialOverAt(t)!;
    const [a, used] = await Promise.all([ensureAccount(t.id), sum({ tenantId: t.id, kind: "CHARGE", createdAt: { gte: t.trialStartedAt ?? t.trialEndsAt!, lt: over } })]);
    const leftover = trialLeftoverCents({ allowanceCents: t.trialAllowanceCents ?? 0, trialChargesCents: -used, balanceCents: a.balanceCents });
    if (leftover > 0) await postEntry({ tenantId: t.id, kind: "TRIAL_CREDIT", category: "TRIAL", amountCents: -leftover, note: "Unused free trial allowance removed at the end of the trial", uniqueKey: `trial:${t.id}:expire` });
    await prisma.tenant.update({ where: { id: t.id }, data: { trialClosedAt: now } });
    if (!t.trialConvertedAt) {
      await prisma.billingAccount.update({ where: { tenantId: t.id }, data: { suspended: true, suspendedAt: now, suspendReason: "TRIAL_ENDED" } });
      emitToTenant(t.id, "billing:update", { suspended: true, message: TRIAL_ENDED_MESSAGE });
    }
    await prisma.auditLog.create({ data: { tenantId: t.id, action: "trial.end", after: { converted: Boolean(t.trialConvertedAt), leftoverRemovedCents: leftover } } });
    log.info({ tenantId: t.id, converted: Boolean(t.trialConvertedAt) }, "trial ended");
  }
}

// ───────────────────────── Sign-up ─────────────────────────

export interface SignupInput {
  clerkUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string;
  businessPhone: string | null;
  refCode: string | null;
  acceptTrialTerms: boolean;
  acceptUsageTerms: boolean;
  /** The business was refused a trial and chose to go ahead without one. */
  withoutTrial: boolean;
}

export type SignupResult = { ok: true; tenantId: string; trial: boolean; referredBy: string | null } | { ok: false; error: string; trialRefused?: boolean };

async function takenFor(email: string, phone: string | null) {
  const key = businessKey(email);
  const domain = key.includes("@") ? key.split("@")[1]! : key;
  const [users, claims, phones] = await Promise.all([
    prisma.user.findMany({ where: { email: { endsWith: `@${domain}`, mode: "insensitive" } }, select: { email: true } }),
    prisma.trialClaim.findMany({ where: { OR: [{ businessKey: key }, ...(phone ? [{ phone }] : [])] }, select: { businessKey: true, phone: true } }),
    phone ? prisma.tenant.findMany({ where: { businessPhone: phone }, select: { businessPhone: true } }) : Promise.resolve([]),
  ]);
  return { takenKeys: [...users.map((u) => businessKey(u.email)), ...claims.map((c) => c.businessKey)], takenPhones: [...claims.map((c) => c.phone), ...phones.map((p) => p.businessPhone!)] };
}

/** Who a code points at, if it can refer: a client (not the platform) that accepted the referral terms and is not closed. */
export async function referrerForCode(raw: string | null | undefined) {
  const code = normalizeReferralCode(raw);
  if (!code) return null;
  const t = await prisma.tenant.findUnique({ where: { referralCode: code }, select: { id: true, name: true, isPlatform: true, closedAt: true, referralTermsAcceptedAt: true } });
  if (!t || t.isPlatform || t.closedAt || !t.referralTermsAcceptedAt) return null;
  return { id: t.id, name: t.name, code };
}

/** What the onboarding page should offer this person. */
export async function signupOffer(email: string, refCode: string | null, clerkUserId: string | null, phone: string | null) {
  const r = await rates();
  const referrer = await referrerForCode(refCode);
  let selfReferral = false;
  if (referrer) {
    const people = await prisma.user.findMany({ where: { tenantId: referrer.id }, select: { email: true, clerkUserId: true } });
    selfReferral = isSelfReferral({ signupEmail: email, signupClerkUserId: clerkUserId, referrerEmails: people.map((p) => p.email), referrerClerkUserIds: people.map((p) => p.clerkUserId) });
  }
  const offered = Boolean(referrer && !selfReferral) || r.trialWithoutReferral;
  // Only the email is known before the form is sent; a phone already used is refused on submit.
  const key = businessKey(email);
  const taken = offered ? new Set((await takenFor(email, normalizePhone(phone ?? ""))).takenKeys) : new Set<string>();
  const refusedReason = taken.has(key) ? (key.includes("@") ? "This email address has already been used for a Strowger workspace or trial." : `A business at ${key} already has a Strowger workspace or has had a trial.`) : null;
  return {
    referrer: referrer && !selfReferral ? { name: referrer.name } : null,
    selfReferral,
    trial: offered ? { days: r.trialDays, seats: r.trialSeats, allowanceCents: r.trialAllowanceCents, maxNumbers: r.trialMaxNumbers } : null,
    refusedReason,
  };
}

/** Create a signed-up person's workspace, with the trial and the referral when they apply. */
export async function signup(input: SignupInput): Promise<SignupResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.companyName.trim();
  if (name.length < 2) return { ok: false, error: "Company name is required" };
  if (!input.acceptUsageTerms) return { ok: false, error: "Accept the usage terms to continue: you are responsible for consent and TCPA compliance on the leads you dial." };
  if (await prisma.user.findUnique({ where: { clerkUserId: input.clerkUserId } })) return { ok: false, error: "You already have a workspace" };

  const r = await rates();
  const referrer = await referrerForCode(input.refCode);
  let self = false;
  if (referrer) {
    const people = await prisma.user.findMany({ where: { tenantId: referrer.id }, select: { email: true, clerkUserId: true } });
    self = isSelfReferral({ signupEmail: email, signupClerkUserId: input.clerkUserId, referrerEmails: people.map((p) => p.email), referrerClerkUserIds: people.map((p) => p.clerkUserId) });
  }
  const offered = Boolean(referrer && !self) || r.trialWithoutReferral;
  const phone = normalizePhone(input.businessPhone ?? "");
  let trial = false;
  let claimKey: string | null = null;
  if (offered && !input.withoutTrial) {
    const check = checkTrialEligible({ email, phone, ...(await takenFor(email, phone)) });
    if (!check.ok) return { ok: false, error: check.reason, trialRefused: true };
    if (!input.acceptTrialTerms) return { ok: false, error: "Accept the Trial Terms to start the free trial." };
    trial = true;
    claimKey = check.key;
  }
  // A referral counts only for a business new to Strowger, i.e. one that gets the trial.
  const attribute = trial && referrer && !self ? referrer : null;

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "workspace";
  let slug = base;
  for (let n = 2; await prisma.tenant.findUnique({ where: { slug } }); n++) slug = `${base}-${n}`;
  const now = new Date();
  const endsAt = new Date(now.getTime() + r.trialDays * 86_400_000);

  const tenant = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        name,
        slug,
        businessPhone: phone,
        usageTermsAcceptedAt: now,
        referredByTenantId: attribute?.id ?? null,
        ...(trial ? { trialStartedAt: now, trialEndsAt: endsAt, trialSeats: r.trialSeats, trialMaxNumbers: r.trialMaxNumbers, trialAllowanceCents: r.trialAllowanceCents, trialTermsAcceptedAt: now, trialTermsVersion: TRIAL_TERMS_VERSION } : {}),
      },
    });
    await tx.billingAccount.create({ data: { tenantId: t.id } });
    const user = await tx.user.create({ data: { tenantId: t.id, clerkUserId: input.clerkUserId, email, firstName: input.firstName, lastName: input.lastName, roles: ["ADMIN"] } });
    if (trial) await tx.trialClaim.create({ data: { tenantId: t.id, businessKey: claimKey!, phone: phone!, email } });
    if (attribute) await tx.referral.create({ data: { tenantId: attribute.id, referredTenantId: t.id, source: "link", code: attribute.code } });
    await tx.auditLog.create({ data: { tenantId: t.id, actorId: user.id, action: "tenant.create", target: t.id, after: { name, slug, trial, referredBy: attribute?.id ?? null, trialTermsVersion: trial ? TRIAL_TERMS_VERSION : null } } });
    if (attribute) await tx.auditLog.create({ data: { tenantId: attribute.id, action: "referral.signup", target: t.id, after: { referred: name } } });
    if (trial && r.trialAllowanceCents > 0) await postEntry({ tenantId: t.id, kind: "TRIAL_CREDIT", category: "TRIAL", amountCents: r.trialAllowanceCents, note: `Free trial usage allowance (${r.trialDays} days). Not money: excluded from referral commission, cannot be withdrawn, removed at trial end if unused.`, uniqueKey: `trial:${t.id}:grant` }, tx);
    return t;
  });
  return { ok: true, tenantId: tenant.id, trial, referredBy: attribute?.name ?? null };
}

// ───────────────────────── Views ─────────────────────────

function relationStatus(ref: { endedAt: Date | null }, referred: TenantRow, now: Date, estimate: { status: string } | null): "trial" | "active" | "inactive" | "ended" {
  if (ref.endedAt) return "ended";
  if (inTrial(referred, now)) return "trial";
  return estimate?.status === "CREDIT" ? "active" : "inactive";
}

/** The client's Refer & earn page. */
export async function referralsForTenant(tenantId: string, now = new Date()) {
  const r = await rates();
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { referralPctOverride: true } });
  const pct = referralPct(Number(r.referralPct), num(t.referralPctOverride));
  const period = periodOf(now);
  const { start } = monthRange(period);
  const refs = await prisma.referral.findMany({ where: { tenantId }, include: REF_INCLUDE, orderBy: { createdAt: "desc" } });
  const rows = [];
  for (const ref of refs) {
    const est = ref.endedAt ? null : await computeFor(ref, period, start, now, Number(r.referralPct));
    const life = await prisma.referralPayout.aggregate({ where: { referralId: ref.id }, _sum: { creditCents: true, clawbackCents: true } });
    rows.push({
      id: ref.id,
      name: ref.referred.name,
      joinedAt: ref.createdAt.toISOString(),
      status: relationStatus(ref, ref.referred, now, est ? { status: est.result.status } : null),
      endedReason: ref.endedReason,
      monthBaseCents: est?.result.baseCents ?? 0,
      monthEstimateCents: est?.result.creditCents ?? 0,
      monthReason: est?.result.reason ?? null,
      lifetimeCents: (life._sum.creditCents ?? 0) - (life._sum.clawbackCents ?? 0),
    });
  }
  const payouts = await prisma.referralPayout.findMany({ where: { tenantId }, orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 50, include: { referral: { select: { referred: { select: { name: true } } } } } });
  return {
    pct,
    period,
    rows,
    totals: { monthEstimateCents: rows.reduce((n, x) => n + x.monthEstimateCents, 0), lifetimeCents: rows.reduce((n, x) => n + x.lifetimeCents, 0), active: rows.filter((x) => x.status === "active").length },
    history: payouts.map((p) => ({ id: p.id, period: p.period, name: p.referral.referred.name, status: p.status, pct: Number(p.pct), baseCents: p.baseCents, creditCents: p.creditCents, clawbackCents: p.clawbackCents, reason: p.reason })),
  };
}

/** The platform's Referrals card. */
export async function referralsPlatform(now = new Date()) {
  const r = await rates();
  const last = previousPeriod(now);
  const refs = await prisma.referral.findMany({ include: { ...REF_INCLUDE, payouts: { select: { period: true, baseCents: true, creditCents: true, clawbackCents: true, status: true, reason: true } } }, orderBy: { createdAt: "desc" } });
  const tenants = await prisma.tenant.findMany({ where: { isPlatform: false }, select: { id: true, name: true, referralCode: true, referralPctOverride: true, referralTermsAcceptedAt: true, trialEndsAt: true, trialConvertedAt: true, trialStartedAt: true }, orderBy: { name: "asc" } });
  return {
    settings: { referralPct: Number(r.referralPct), trialDays: r.trialDays, trialSeats: r.trialSeats, trialAllowanceCents: r.trialAllowanceCents, trialMaxNumbers: r.trialMaxNumbers, trialWithoutReferral: r.trialWithoutReferral },
    lastPeriod: last,
    lastRun: (await prisma.referralPayout.findFirst({ where: { period: last }, select: { createdAt: true } }))?.createdAt.toISOString() ?? null,
    relationships: refs.map((ref) => {
      const lp = ref.payouts.find((p) => p.period === last);
      return {
        id: ref.id,
        referrerId: ref.tenantId,
        referrer: ref.tenant.name,
        referredId: ref.referredTenantId,
        referred: ref.referred.name,
        since: ref.createdAt.toISOString(),
        source: ref.source,
        lockedAt: ref.lockedAt?.toISOString() ?? null,
        endedAt: ref.endedAt?.toISOString() ?? null,
        endedReason: ref.endedReason,
        status: ref.endedAt ? "ended" : inTrial(ref.referred, now) ? "trial" : lp?.status === "CREDIT" ? "active" : lp ? "inactive" : "new",
        lastBaseCents: lp?.baseCents ?? null,
        lastCreditCents: lp?.creditCents ?? null,
        lastReason: lp?.reason ?? null,
        lifetimeCents: ref.payouts.reduce((n, p) => n + p.creditCents - p.clawbackCents, 0),
      };
    }),
    tenants: tenants.map((t) => ({ id: t.id, name: t.name, code: t.referralCode, termsAccepted: Boolean(t.referralTermsAcceptedAt), pctOverride: num(t.referralPctOverride), trial: t.trialEndsAt ? (inTrial(t, now) ? "trial" : t.trialConvertedAt ? "converted" : "ended") : null })),
    defaults: REFERRAL_DEFAULTS,
  };
}

// ───────────────────────── Platform actions ─────────────────────────

export async function saveReferralSettings(s: { referralPct: number; trialDays: number; trialSeats: number; trialAllowanceCents: number; trialMaxNumbers: number; trialWithoutReferral: boolean }) {
  await rates();
  return prisma.platformRates.update({ where: { id: "default" }, data: s });
}

export async function setReferrerOverride(tenantId: string, pct: number | null) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { referralPctOverride: pct } });
}

/** Change who referred a client: only until the client's first payment locks it. Never the client itself, never a second level of the same chain into a loop. */
export async function changeAttribution(referralId: string, newReferrerId: string) {
  const ref = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
  if (ref.lockedAt) throw new Error("Locked: the referred client has made its first payment");
  if (ref.endedAt) throw new Error("This referral has ended");
  if (newReferrerId === ref.referredTenantId) throw new Error("A client cannot refer itself");
  const t = await prisma.tenant.findUnique({ where: { id: newReferrerId }, select: { isPlatform: true } });
  if (!t || t.isPlatform) throw new Error("Pick a client workspace");
  const before = ref.tenantId;
  await prisma.$transaction([prisma.referral.update({ where: { id: referralId }, data: { tenantId: newReferrerId, source: "platform" } }), prisma.tenant.update({ where: { id: ref.referredTenantId }, data: { referredByTenantId: newReferrerId } })]);
  return { before, after: newReferrerId, referredTenantId: ref.referredTenantId };
}

export async function endReferral(referralId: string, reason: string) {
  const ref = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
  if (ref.endedAt) return ref;
  return prisma.referral.update({ where: { id: referralId }, data: { endedAt: new Date(), endedReason: reason || "Ended by the platform" } });
}
