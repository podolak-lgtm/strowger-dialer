// Referral program and free trial (owner, 6 Nov). The money rules are pure
// and tested here; the engine (`apps/engine/src/referrals`) gathers the
// ledger numbers and writes the credits. Plain words for each rule are in
// docs/HANDOFF.md "Referral program and free trial" and in the terms pages
// (`apps/web/src/app/legal/referral-terms`, `.../trial-terms`): change all
// three together.
import { normalizePhone } from "./phone";

/** Bump when the referral terms page changes in substance; clients accept again on their next visit. */
export const REFERRAL_TERMS_VERSION = "2026-11-06";
export const TRIAL_TERMS_VERSION = "2026-11-06";

export const REFERRAL_COOKIE = "strowger_ref";
export const REFERRAL_COOKIE_DAYS = 30;
/** A referrer with no payment and no usage for this long loses every referral, permanently. */
export const REFERRER_INACTIVE_DAYS = 60;
/** Day of the trial on which the reminder goes out (day 1 = the sign-up day). */
export const TRIAL_REMINDER_DAY = 5;

export const REFERRAL_DEFAULTS = { pct: 5, trialDays: 7, trialSeats: 5, trialAllowanceCents: 5000, trialMaxNumbers: 3 } as const;

const DAY = 86_400_000;

// ───────────────────────── Links ─────────────────────────

/** No 0/O, 1/I/L: codes get read out on the phone. */
export const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REFERRAL_CODE_LENGTH = 8;

export function isReferralCode(code: string | null | undefined): code is string {
  if (!code || code.length !== REFERRAL_CODE_LENGTH) return false;
  for (const ch of code) if (!REFERRAL_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** A code from random bytes (crypto.getRandomValues in the caller), so this stays pure. */
export function referralCodeFrom(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) s += REFERRAL_CODE_ALPHABET[(bytes[i] ?? 0) % REFERRAL_CODE_ALPHABET.length];
  return s;
}

export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().toUpperCase();
  return isReferralCode(c) ? c : null;
}

// ───────────────────────── One trial per business ─────────────────────────

/** Free mailbox providers: the domain says nothing about the business, so the whole address is the key. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
]);

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

export function isFreeMail(email: string): boolean {
  const d = emailDomain(email);
  return FREE_MAIL_DOMAINS.has(d) || /^yahoo\.|^hotmail\.|^outlook\.|^live\./.test(d);
}

/**
 * What identifies a business by its email: the domain (acme.com), or the
 * whole address for free mail (jane@gmail.com). Gmail dots and +tags are
 * folded so one mailbox cannot claim many trials.
 */
export function businessKey(email: string): string {
  const e = email.trim().toLowerCase();
  if (!isFreeMail(e)) return emailDomain(e);
  const [local = "", domain = ""] = e.split("@");
  let l = local.split("+")[0] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") l = l.replace(/\./g, "");
  return `${l}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export interface TrialCheckInput {
  email: string;
  phone: string | null | undefined;
  /** Business keys (see businessKey) of every existing client's people and of every earlier trial. */
  takenKeys: Iterable<string>;
  /** Business phones (ten digits) of existing clients and earlier trials. */
  takenPhones: Iterable<string>;
}

export type TrialCheck = { ok: true; key: string; phone: string } | { ok: false; reason: string };

/** One trial per business: refused when the email's business key or the business phone is already known. */
export function checkTrialEligible(input: TrialCheckInput): TrialCheck {
  const phone = normalizePhone(input.phone ?? "");
  if (!phone) return { ok: false, reason: "A valid ten-digit US business phone number is needed for the free trial." };
  const key = businessKey(input.email);
  if (!key || !key.includes(".")) return { ok: false, reason: "A valid email address is needed for the free trial." };
  if (new Set(input.takenKeys).has(key)) {
    return { ok: false, reason: key.includes("@") ? "This email address has already been used for a Strowger workspace or trial." : `A business at ${key} already has a Strowger workspace or has had a trial.` };
  }
  if (new Set(input.takenPhones).has(phone)) return { ok: false, reason: "This business phone number already belongs to a Strowger workspace or an earlier trial." };
  return { ok: true, key, phone };
}

/** Self-referral: the new business shares the referrer's email business key, or is the same signed-in person. */
export function isSelfReferral(input: { signupEmail: string; signupClerkUserId?: string | null; referrerEmails: string[]; referrerClerkUserIds: (string | null)[] }): boolean {
  if (input.signupClerkUserId && input.referrerClerkUserIds.includes(input.signupClerkUserId)) return true;
  const key = businessKey(input.signupEmail);
  return input.referrerEmails.some((e) => businessKey(e) === key);
}

// ───────────────────────── Trial state ─────────────────────────

export interface TrialFields {
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialConvertedAt: Date | null;
}

/** In trial = a trial was started, has not ended, and no payment has been recorded yet. */
export function inTrial(t: TrialFields, now: Date): boolean {
  return Boolean(t.trialEndsAt && !t.trialConvertedAt && now.getTime() < t.trialEndsAt.getTime());
}

/** When the trial stopped counting as a trial: the first payment or the end date, whichever came first. */
export function trialOverAt(t: TrialFields): Date | null {
  if (!t.trialEndsAt) return null;
  if (t.trialConvertedAt && t.trialConvertedAt < t.trialEndsAt) return t.trialConvertedAt;
  return t.trialEndsAt;
}

/** Day of the trial, 1 on the sign-up day. */
export function trialDay(t: TrialFields, now: Date): number {
  if (!t.trialStartedAt) return 0;
  return Math.floor((now.getTime() - t.trialStartedAt.getTime()) / DAY) + 1;
}

export function trialDaysLeft(t: TrialFields, now: Date): number {
  if (!t.trialEndsAt) return 0;
  return Math.max(0, Math.ceil((t.trialEndsAt.getTime() - now.getTime()) / DAY));
}

export function trialReminderDue(t: TrialFields & { trialReminderAt: Date | null }, now: Date): boolean {
  return inTrial(t, now) && !t.trialReminderAt && trialDay(t, now) >= TRIAL_REMINDER_DAY;
}

/**
 * At the end of the trial the unused allowance is removed: it was never
 * money, so it neither carries forward nor counts toward anything. Unused =
 * the allowance less what the trial used, and never more than the balance.
 */
export function trialLeftoverCents(input: { allowanceCents: number; trialChargesCents: number; balanceCents: number }): number {
  const unused = Math.max(0, input.allowanceCents - Math.max(0, input.trialChargesCents));
  return Math.max(0, Math.min(unused, input.balanceCents));
}

// ───────────────────────── Months ─────────────────────────

/** UTC month bounds for "YYYY-MM": [start, end). */
export function monthRange(period: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`Bad period ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}

export function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function previousPeriod(d: Date): string {
  return periodOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
}

// ───────────────────────── Commission ─────────────────────────

/** Commission on a base at a percent (5 = 5%), to the cent. $1,000 at 5% = $50. */
export function commissionCents(baseCents: number, pct: number): number {
  if (baseCents <= 0 || pct <= 0) return 0;
  return Math.round((baseCents * pct) / 100);
}

/**
 * The base for one referred client's month: what they were charged that was
 * covered by real money. Charges exclude anything used up during the trial;
 * money = payments credited in the month, less refunds in the month, plus the
 * positive balance they carried in from real payments (never trial credit or
 * referral credit). base = min(charges, money), never below zero.
 */
export function commissionBase(input: { chargesCents: number; paymentsCents: number; refundsCents: number; openingFundedCents: number }): number {
  const money = Math.max(0, input.paymentsCents - input.refundsCents) + Math.max(0, input.openingFundedCents);
  return Math.max(0, Math.min(Math.max(0, input.chargesCents), money));
}

export interface ReferrerMonth {
  /** Suspended (any reason) when the month closed. */
  suspendedAtEnd: boolean;
  /** Closed workspace. */
  closed: boolean;
  paymentsCents: number;
  balanceAtEndCents: number;
  seatCharges: number;
}

export interface ReferredMonth {
  suspendedAtEnd: boolean;
  closed: boolean;
  inTrialAtEnd: boolean;
  /** Charges in the month after the trial was over (positive cents). */
  chargesCents: number;
  paymentsCents: number;
  refundsCents: number;
  openingFundedCents: number;
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** Both sides must be active clients in the month, or the month's commission is forfeited (not banked). */
export function monthEligibility(referrer: ReferrerMonth, referred: ReferredMonth): Eligibility {
  if (referrer.closed) return { ok: false, reason: "Your workspace is closed" };
  if (referrer.suspendedAtEnd) return { ok: false, reason: "Your workspace was suspended at month end" };
  if (referrer.paymentsCents <= 0 && referrer.balanceAtEndCents <= 0) return { ok: false, reason: "You made no payment and had no balance that month" };
  if (referrer.seatCharges <= 0) return { ok: false, reason: "You had no active seat that month" };
  if (referred.closed) return { ok: false, reason: "Their workspace is closed" };
  if (referred.inTrialAtEnd) return { ok: false, reason: "They were still in their free trial" };
  if (referred.suspendedAtEnd) return { ok: false, reason: "Their workspace was suspended at month end" };
  if (referred.chargesCents <= 0) return { ok: false, reason: "They had no paid usage that month" };
  return { ok: true };
}

/**
 * Refunds bigger than the month's own payments reach back into months that
 * were already credited: the excess (up to the base credited before and not
 * yet clawed back) is charged back to the referrer at the same percent.
 */
export function clawbackCents(input: { paymentsCents: number; refundsCents: number; priorBaseCents: number; priorClawedBaseCents: number; pct: number }): { baseCents: number; amountCents: number } {
  const excess = Math.max(0, input.refundsCents - input.paymentsCents);
  const open = Math.max(0, input.priorBaseCents - input.priorClawedBaseCents);
  const base = Math.min(excess, open);
  return { baseCents: base, amountCents: commissionCents(base, input.pct) };
}

export interface ReferralMonthInput {
  pct: number;
  /** The relationship had ended (inactive referrer, closure, or by the platform) before the month closed. */
  endedBeforeMonthEnd: boolean;
  referrer: ReferrerMonth;
  referred: ReferredMonth;
  priorBaseCents: number;
  priorClawedBaseCents: number;
}

export interface ReferralMonthResult {
  status: "CREDIT" | "FORFEITED";
  baseCents: number;
  creditCents: number;
  reason: string | null;
  clawbackBaseCents: number;
  clawbackCents: number;
}

/** One relationship, one month: the credit (or why it is forfeited) and any clawback. */
export function computeReferralMonth(i: ReferralMonthInput): ReferralMonthResult {
  const claw = clawbackCents({ paymentsCents: i.referred.paymentsCents, refundsCents: i.referred.refundsCents, priorBaseCents: i.priorBaseCents, priorClawedBaseCents: i.priorClawedBaseCents, pct: i.pct });
  const base = commissionBase(i.referred);
  const elig: Eligibility = i.endedBeforeMonthEnd ? { ok: false, reason: "The referral had ended" } : monthEligibility(i.referrer, i.referred);
  if (!elig.ok) return { status: "FORFEITED", baseCents: base, creditCents: 0, reason: elig.reason, clawbackBaseCents: claw.baseCents, clawbackCents: claw.amountCents };
  return { status: "CREDIT", baseCents: base, creditCents: commissionCents(base, i.pct), reason: null, clawbackBaseCents: claw.baseCents, clawbackCents: claw.amountCents };
}

/** A referrer with no payment and no usage for 60 days (or a closed workspace) loses every referral for good. */
export function referrerLapsed(input: { lastActivityAt: Date | null; createdAt: Date; closedAt: Date | null; now: Date }): { lapsed: false } | { lapsed: true; reason: string } {
  if (input.closedAt) return { lapsed: true, reason: "Referrer's workspace closed" };
  const since = input.lastActivityAt && input.lastActivityAt > input.createdAt ? input.lastActivityAt : input.createdAt;
  if (input.now.getTime() - since.getTime() >= REFERRER_INACTIVE_DAYS * DAY) return { lapsed: true, reason: `No payment or usage by the referrer for ${REFERRER_INACTIVE_DAYS} days` };
  return { lapsed: false };
}

/** The rate that applies to a referrer: their override when set, else the platform rate. */
export function referralPct(platformPct: number, override: number | null | undefined): number {
  return override === null || override === undefined ? platformPct : override;
}

export function referralNote(input: { referredName: string; period: string; pct: number; baseCents: number }): string {
  const base = (input.baseCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Referral credit: ${input.referredName}, ${input.period}, ${Number(input.pct.toFixed(2))}% of $${base}`;
}

export function clawbackNote(input: { referredName: string; period: string; pct: number; baseCents: number }): string {
  const base = (input.baseCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Referral clawback: ${input.referredName} refund in ${input.period}, ${Number(input.pct.toFixed(2))}% of $${base}`;
}
