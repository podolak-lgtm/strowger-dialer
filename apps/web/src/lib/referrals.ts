// Referral links and trial offer, read side (web). Money is written by the
// engine (`apps/engine/src/referrals`); this only finds a code's referrer and
// gives a client its code. See docs/HANDOFF.md "Referral program and free trial".
import "server-only";
import { prisma } from "@strowger/db";
import { REFERRAL_DEFAULTS, normalizeReferralCode, referralCodeFrom } from "@strowger/shared/referrals";

export function publicBase(): string {
  return (process.env.WEB_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://strowger.crossbar.digital").replace(/\/$/, "");
}

export function referralLink(code: string): string {
  return `${publicBase()}/r/${code}`;
}

/** The client a code belongs to, if it may refer: not the platform, not closed, referral terms accepted. */
export async function referrerByCode(raw: string | null | undefined) {
  const code = normalizeReferralCode(raw);
  if (!code) return null;
  const t = await prisma.tenant.findUnique({ where: { referralCode: code }, select: { id: true, name: true, isPlatform: true, closedAt: true, referralTermsAcceptedAt: true } });
  if (!t || t.isPlatform || t.closedAt || !t.referralTermsAcceptedAt) return null;
  return { id: t.id, name: t.name, code };
}

/** The trial on offer now (platform settings, else the defaults). */
export async function trialOffer() {
  const r = await prisma.platformRates.findUnique({ where: { id: "default" }, select: { trialDays: true, trialSeats: true, trialAllowanceCents: true, trialMaxNumbers: true, referralPct: true } });
  return { days: r?.trialDays ?? REFERRAL_DEFAULTS.trialDays, seats: r?.trialSeats ?? REFERRAL_DEFAULTS.trialSeats, allowanceCents: r?.trialAllowanceCents ?? REFERRAL_DEFAULTS.trialAllowanceCents, maxNumbers: r?.trialMaxNumbers ?? REFERRAL_DEFAULTS.trialMaxNumbers, pct: r ? Number(r.referralPct) : REFERRAL_DEFAULTS.pct };
}

/** A client's stable code, made the first time its Refer page is opened. */
export async function ensureReferralCode(tenantId: string): Promise<string> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { referralCode: true } });
  if (t.referralCode) return t.referralCode;
  for (let i = 0; i < 8; i++) {
    const code = referralCodeFrom(crypto.getRandomValues(new Uint8Array(8)));
    const r = await prisma.tenant.updateMany({ where: { id: tenantId, referralCode: null }, data: { referralCode: code } }).catch(() => null);
    if (r?.count === 1) return code;
    const again = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { referralCode: true } });
    if (again.referralCode) return again.referralCode;
  }
  throw new Error("Could not make a referral code");
}

export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
