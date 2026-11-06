"use server";

import { requireRole, requireSession } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@strowger/db";

export type BillingStatus = {
  isPlatform: boolean;
  balanceCents: number;
  lowBalanceCents: number;
  low: boolean;
  critical: boolean;
  suspended: boolean;
  suspendReason: string | null;
  trial: { active: boolean; endsAt: string; startedAt: string | null; convertedAt: string | null; reminderAt: string | null; allowanceCents: number; seats: number; maxNumbers: number } | null;
  graceDays: number;
  zeroSince: string | null;
  dailyAvgCents: number;
  runwayDays: number | null;
  rates: { seatMonthlyCents: number; perMinuteMillicents: number; didMarkupPct: number; scrubMarginMillicents: number; smsPriceMillicents: number };
};
export type BillingOverview = {
  period: string;
  referralCreditsCents: number;
  status: BillingStatus;
  categories: { category: string; amountCents: number; quantity: number; costCents: number }[];
  entries: { id: string; kind: string; category: string; quantity: number; unitMillicents: number; amountCents: number; note: string | null; at: string; period: string }[];
  statements: { period: string; amountCents: number }[];
  prepayInstructions: string | null;
};
export type PlatformOverview = {
  period: string;
  rates: { telnyxOutMillicentsPerMin: number; telnyxInMillicentsPerMin: number; didMonthlyCents: number; scrubCostMillicents: number; smsCostMillicents: number; prepayInstructions: string | null };
  tenants: {
    id: string;
    name: string;
    slug: string;
    users: number;
    seats: number;
    balanceCents: number;
    suspended: boolean;
    lowBalanceCents: number;
    revenueCents: number;
    costCents: number;
    marginCents: number;
    plan: { seatMonthlyCents: number; perMinuteMillicents: number; didMarkupPct: number; scrubMarginMillicents: number; smsPriceMillicents: number; lowBalanceCents: number; graceDays: number } | null;
  }[];
};

export async function billingStatus(): Promise<BillingStatus | null> {
  const s = await requireSession();
  try {
    return await engine<BillingStatus>(`/billing/status?tenantId=${s.tenant.id}`);
  } catch {
    return null;
  }
}

export async function billingOverview(period?: string): Promise<BillingOverview> {
  const s = await requireRole("SUPERVISOR");
  return engine<BillingOverview>(`/billing/overview?tenantId=${s.tenant.id}${period ? `&period=${period}` : ""}`);
}

async function platformOnly() {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) throw new Error("Platform workspace only");
  return s;
}

export type VendorSpend = {
  period: string;
  rows: { vendor: string; kind: string; costCents: number; quantity: number; records: number }[];
  totalCents: number;
  unattributedCents: number;
  byTenant: { tenantId: string; costCents: number }[];
  telnyxBalanceCents: number | null;
  telnyxBalanceAt: string | null;
  telnyxSyncedAt: string | null;
};

export async function vendorSpend(period?: string): Promise<VendorSpend> {
  await platformOnly();
  return engine<VendorSpend>(`/billing/vendor${period ? `?period=${period}` : ""}`);
}

export async function syncVendorCosts() {
  await platformOnly();
  try {
    await engine("/billing/vendor/sync", { method: "POST", body: JSON.stringify({ dateRange: "last_7_days" }) });
    redirect("/platform?msg=" + encodeURIComponent("Telnyx records pulled for the last 7 days."));
  } catch (e) {
    if (typeof e === "object" && e && "digest" in e) throw e;
    redirect("/platform?msg=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) + "&kind=error");
  }
}

export async function createWorkspace(formData: FormData) {
  const s = await platformOnly();
  const name = String(formData.get("name") ?? "").trim();
  const adminEmail = String(formData.get("adminEmail") ?? "").trim().toLowerCase() || null;
  const r = await engine<{ ok: boolean; id: string; slug: string }>("/workspaces", { method: "POST", body: JSON.stringify({ name, adminEmail }) });
  await prisma.auditLog.create({ data: { tenantId: s.actingFrom?.id ?? s.tenant.id, actorId: s.user.id, action: "workspace.create", target: r.id, after: { name, adminEmail } } });
  revalidatePath("/platform");
  redirect("/platform?msg=" + encodeURIComponent(`Workspace "${name}" created${adminEmail ? `; ${adminEmail} can sign in as its admin` : ""}.`));
}

/** Step into a client workspace: every page scopes to it until "Back". */
export async function openWorkspace(formData: FormData) {
  const s = await platformOnly();
  const tenantId = String(formData.get("tenantId"));
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!t) throw new Error("Unknown workspace");
  (await cookies()).set("strowger_ws", tenantId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 12 * 3600 });
  await Promise.all([
    prisma.auditLog.create({ data: { tenantId, actorId: s.user.id, action: "workspace.enter" } }),
    // Remembered so /platform can offer "Continue in <client>" next sign-in.
    prisma.user.update({ where: { id: s.user.id }, data: { lastWorkspaceId: tenantId } }),
  ]);
  redirect("/dashboard");
}

export async function leaveWorkspace() {
  (await cookies()).delete("strowger_ws");
  redirect("/platform");
}

export async function moveCampaignToWorkspace(formData: FormData) {
  const s = await platformOnly();
  const campaignId = String(formData.get("campaignId"));
  const toTenantId = String(formData.get("toTenantId"));
  const fromTenantId = s.tenant.id;
  try {
    const r = await engine<{ ok: boolean; report: Record<string, number | string> }>("/workspaces/move-campaign", { method: "POST", body: JSON.stringify({ campaignId, fromTenantId, toTenantId }) });
    await prisma.auditLog.create({ data: { tenantId: fromTenantId, actorId: s.user.id, action: "workspace.move-campaign", target: campaignId, after: { toTenantId, ...r.report } } });
    const rep = r.report;
    redirect("/platform?msg=" + encodeURIComponent(`Moved "${rep.campaign}": ${rep.lists} lists, ${rep.leads} leads, ${rep.calls} calls, ${rep.messages} texts, ${rep.numbers} numbers, ${rep.people} people, ${rep.dnc} DNC entries copied.`));
  } catch (e) {
    if (typeof e === "object" && e && "digest" in e) throw e;
    const m = e instanceof Error ? e.message : String(e);
    const j = m.match(/"error":"(.*)"\}$/);
    redirect("/platform?msg=" + encodeURIComponent(j ? j[1] : m) + "&kind=error");
  }
}

export async function platformOverview(period?: string): Promise<PlatformOverview> {
  await platformOnly();
  return engine<PlatformOverview>(`/billing/platform${period ? `?period=${period}` : ""}`);
}

export async function recordPayment(formData: FormData) {
  const s = await platformOnly();
  const tenantId = String(formData.get("tenantId"));
  const dollars = Number(String(formData.get("amount") ?? "").replace(/[^0-9.-]/g, ""));
  const amountCents = Math.round(dollars * 100);
  const note = String(formData.get("note") ?? "").trim() || "Prepayment";
  await engine("/billing/payment", { method: "POST", body: JSON.stringify({ tenantId, amountCents, note, createdById: s.user.id }) });
  revalidatePath("/platform");
  revalidatePath("/billing");
}

export async function savePlan(formData: FormData) {
  await platformOnly();
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, "")) || 0;
  await engine("/billing/plan", {
    method: "POST",
    body: JSON.stringify({
      tenantId: String(formData.get("tenantId")),
      seatMonthlyCents: Math.round(n("seat") * 100),
      perMinuteMillicents: Math.round(n("perMinute") * 1000),
      didMarkupPct: Math.round(n("didMarkup")),
      scrubMarginMillicents: Math.round(n("scrubMargin") * 1000),
      smsPriceMillicents: Math.round(n("smsPrice") * 1000),
      lowBalanceCents: Math.round(n("lowBalance") * 100),
      graceDays: Math.round(n("graceDays")),
    }),
  });
  revalidatePath("/platform");
}

export async function saveRates(formData: FormData) {
  await platformOnly();
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, "")) || 0;
  await engine("/billing/rates", {
    method: "POST",
    body: JSON.stringify({
      telnyxOutMillicentsPerMin: Math.round(n("outPerMin") * 1000),
      telnyxInMillicentsPerMin: Math.round(n("inPerMin") * 1000),
      didMonthlyCents: Math.round(n("didMonthly") * 100),
      scrubCostMillicents: Math.round(n("scrubCost") * 1000),
      smsCostMillicents: Math.round(n("smsCost") * 1000),
      prepayInstructions: String(formData.get("prepayInstructions") ?? "").trim() || null,
    }),
  });
  revalidatePath("/platform");
  revalidatePath("/billing");
}
