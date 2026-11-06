"use server";

// Refer & earn (clients) and the platform's Referrals card. Ledger work and
// the month run are the engine's (`/internal/referrals/*`); every admin
// change is audit-logged here, like the other billing actions.
import { prisma } from "@strowger/db";
import { REFERRAL_TERMS_VERSION } from "@strowger/shared/referrals";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireClientWorkspace, requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

export type MyReferrals = {
  pct: number;
  period: string;
  rows: { id: string; name: string; joinedAt: string; status: "trial" | "active" | "inactive" | "ended"; endedReason: string | null; monthBaseCents: number; monthEstimateCents: number; monthReason: string | null; lifetimeCents: number }[];
  totals: { monthEstimateCents: number; lifetimeCents: number; active: number };
  history: { id: string; period: string; name: string; status: string; pct: number; baseCents: number; creditCents: number; clawbackCents: number; reason: string | null }[];
};

export type PlatformReferrals = {
  settings: { referralPct: number; trialDays: number; trialSeats: number; trialAllowanceCents: number; trialMaxNumbers: number; trialWithoutReferral: boolean };
  lastPeriod: string;
  lastRun: string | null;
  relationships: { id: string; referrerId: string; referrer: string; referredId: string; referred: string; since: string; source: string; lockedAt: string | null; endedAt: string | null; endedReason: string | null; status: string; lastBaseCents: number | null; lastCreditCents: number | null; lastReason: string | null; lifetimeCents: number }[];
  tenants: { id: string; name: string; code: string | null; termsAccepted: boolean; pctOverride: number | null; trial: string | null }[];
};

export async function myReferrals(): Promise<MyReferrals> {
  const s = await requireClientWorkspace("SUPERVISOR");
  return engine<MyReferrals>(`/referrals?tenantId=${s.tenant.id}`);
}

export async function acceptReferralTerms(formData: FormData) {
  const s = await requireClientWorkspace("SUPERVISOR");
  if (s.tenant.isPlatform) throw new Error("The platform workspace does not refer");
  if (formData.get("accept") !== "on") redirect("/refer?error=1");
  await prisma.$transaction([
    prisma.tenant.update({ where: { id: s.tenant.id }, data: { referralTermsAcceptedAt: new Date(), referralTermsVersion: REFERRAL_TERMS_VERSION, referralTermsAcceptedById: s.user.id } }),
    prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "referral.terms.accept", after: { version: REFERRAL_TERMS_VERSION, actingFrom: s.actingFrom?.id ?? null } } }),
  ]);
  revalidatePath("/refer");
  redirect("/refer");
}

// ---- Platform

async function platformOnly() {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) throw new Error("Platform workspace only");
  return { s, platformTenantId: s.actingFrom?.id ?? s.tenant.id };
}

const back = (msg: string, error = false): never => redirect("/platform?msg=" + encodeURIComponent(msg) + (error ? "&kind=error" : "") + "#referrals");
const engineError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.match(/"error":"(.*?)"/);
  return j ? j[1] : m;
};
const isRedirect = (e: unknown) => typeof e === "object" && e !== null && "digest" in e;

export async function platformReferrals(): Promise<PlatformReferrals> {
  await platformOnly();
  return engine<PlatformReferrals>("/referrals/platform");
}

export async function saveReferralSettings(formData: FormData) {
  const { s, platformTenantId } = await platformOnly();
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, ""));
  const body = {
    referralPct: Math.round(n("referralPct") * 100) / 100,
    trialDays: Math.round(n("trialDays")),
    trialSeats: Math.round(n("trialSeats")),
    trialAllowanceCents: Math.round(n("trialAllowance") * 100),
    trialMaxNumbers: Math.round(n("trialMaxNumbers")),
    trialWithoutReferral: formData.get("trialWithoutReferral") === "on",
  };
  if (Object.values(body).some((v) => typeof v === "number" && !Number.isFinite(v))) back("Every setting needs a number", true);
  try {
    await engine("/referrals/settings", { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    back(engineError(e), true);
  }
  await prisma.auditLog.create({ data: { tenantId: platformTenantId, actorId: s.user.id, action: "referral.settings", after: body } });
  revalidatePath("/platform");
  back(`Referral and trial settings saved: ${body.referralPct}% commission; trial ${body.trialDays} days, ${body.trialSeats} seats, $${(body.trialAllowanceCents / 100).toFixed(2)}, ${body.trialMaxNumbers} numbers. Changes to the rate apply from the next month run; clients must be given 30 days' notice (Referral Terms).`);
}

export async function setReferrerOverride(formData: FormData) {
  const { s, platformTenantId } = await platformOnly();
  const tenantId = String(formData.get("tenantId"));
  const raw = String(formData.get("pct") ?? "").trim();
  const pct = raw === "" ? null : Math.round(Number(raw) * 100) / 100;
  if (pct !== null && !Number.isFinite(pct)) back("Override must be a number, or blank for the platform rate", true);
  try {
    await engine("/referrals/override", { method: "POST", body: JSON.stringify({ tenantId, pct }) });
  } catch (e) {
    back(engineError(e), true);
  }
  await prisma.auditLog.create({ data: { tenantId: platformTenantId, actorId: s.user.id, action: "referral.override", target: tenantId, after: { pct } } });
  revalidatePath("/platform");
  back(pct === null ? "Override cleared: the platform rate applies." : `Override set to ${pct}%.`);
}

export async function changeAttribution(formData: FormData) {
  const { s, platformTenantId } = await platformOnly();
  const referralId = String(formData.get("referralId"));
  const referrerTenantId = String(formData.get("referrerTenantId"));
  let r: { before: string; after: string; referredTenantId: string } | null = null;
  try {
    r = await engine<{ before: string; after: string; referredTenantId: string }>("/referrals/attribution", { method: "POST", body: JSON.stringify({ referralId, referrerTenantId }) });
  } catch (e) {
    if (isRedirect(e)) throw e;
    back(engineError(e), true);
  }
  await prisma.auditLog.create({ data: { tenantId: platformTenantId, actorId: s.user.id, action: "referral.attribution", target: referralId, before: { referrer: r!.before }, after: { referrer: r!.after, referred: r!.referredTenantId } } });
  revalidatePath("/platform");
  back("Attribution changed.");
}

export async function endReferral(formData: FormData) {
  const { s, platformTenantId } = await platformOnly();
  const referralId = String(formData.get("referralId"));
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 200) || "Ended by the platform";
  try {
    await engine("/referrals/end", { method: "POST", body: JSON.stringify({ referralId, reason }) });
  } catch (e) {
    back(engineError(e), true);
  }
  await prisma.auditLog.create({ data: { tenantId: platformTenantId, actorId: s.user.id, action: "referral.end", target: referralId, after: { reason } } });
  revalidatePath("/platform");
  back("Referral ended. It earns nothing from now on; credits already posted stay on the referrer's account.");
}

export async function runReferralCredits(formData: FormData) {
  const { s, platformTenantId } = await platformOnly();
  const period = String(formData.get("period") ?? "");
  let r: { credited: number; forfeited: number; skipped: number; creditCents: number; clawbackCents: number } | null = null;
  try {
    r = await engine("/referrals/run", { method: "POST", body: JSON.stringify({ period, userId: s.user.id }) });
  } catch (e) {
    back(engineError(e), true);
  }
  await prisma.auditLog.create({ data: { tenantId: platformTenantId, actorId: s.user.id, action: "referral.run", target: period, after: r! } });
  revalidatePath("/platform");
  revalidatePath("/billing");
  back(`Referral credits for ${period}: ${r!.credited} credited ($${(r!.creditCents / 100).toFixed(2)}), ${r!.forfeited} forfeited, ${r!.skipped} already done${r!.clawbackCents ? `, $${(r!.clawbackCents / 100).toFixed(2)} clawed back` : ""}.`);
}
