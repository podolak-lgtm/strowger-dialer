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
  rates: { seatMonthlyCents: number; perMinuteMillicents: number; didMarkupPct: number; scrubMarginMillicents: number; smsPriceMillicents: number; aiMinutePriceMillicents: number; transcriptMinutePriceMillicents?: number; assistCallPriceMillicents?: number };
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
  rates: { telnyxOutMillicentsPerMin: number; telnyxInMillicentsPerMin: number; didMonthlyCents: number; scrubCostMillicents: number; smsCostMillicents: number; aiMinuteCostMillicents: number; sttMinuteCostMillicents?: number; prepayInstructions: string | null };
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
    plan: { seatMonthlyCents: number; perMinuteMillicents: number; didMarkupPct: number; scrubMarginMillicents: number; smsPriceMillicents: number; aiMinutePriceMillicents: number; transcriptMinutePriceMillicents?: number; assistCallPriceMillicents?: number; lowBalanceCents: number; graceDays: number } | null;
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
    redirect("/platform?msg=" + encodeURIComponent("Every vendor synced: usage for the last 7 days, balances and month totals. A vendor that failed shows its error in Balances."));
  } catch (e) {
    if (typeof e === "object" && e && "digest" in e) throw e;
    redirect("/platform?msg=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) + "&kind=error");
  }
}

// ---- Accounting (owner, 6 Nov): P&L per client, vendors, balances, fixed costs

export type VendorAccountRow = {
  vendor: string;
  label: string;
  api: string;
  balanceCents: number | null;
  balanceSource: string | null;
  balanceAt: string | null;
  lowBalanceCents: number | null;
  usageSyncedAt: string | null;
  reportedPeriod: string | null;
  reportedCents: number | null;
  reportedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  note: string | null;
};
export type ClientPnlRow = {
  id: string;
  name: string;
  slug: string;
  trial: boolean;
  balanceCents: number;
  suspended: boolean;
  seats: number;
  minutes: number;
  numbers: number;
  texts: number;
  revenueCents: number;
  costByVendorCents: Record<string, number>;
  attributedCents: number;
  fixedAllocatedCents: number;
  unmatchedAllocatedCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  belowFloor: boolean;
};
export type FixedCostRow = { id: string; tenantId: string | null; tenantName: string | null; vendor: string; kind: string; label: string; amountCents: number; cadence: string; startPeriod: string; endPeriod: string | null; note: string | null };
export type PlatformAccounting = {
  period: string;
  lastPeriod: string;
  settings: { costAllocation: "MINUTES" | "SEATS"; allocateUnattributed: boolean; marginFloorPct: number; ttsCostMillicentsPerKChar: number };
  top: { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null; prepaidHeldCents: number };
  clients: ClientPnlRow[];
  clientTotals: { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null };
  sharedFixedCents: number;
  unattributedCents: number;
  unallocatedCents: number;
  platformOwnCents: number;
  vendors: { vendor: string; kind: string; source: string; thisMillicents: number; thisCents: number; lastCents: number; quantity: number; records: number }[];
  vendorTotals: { thisCents: number; lastCents: number };
  accounts: VendorAccountRow[];
  fixedCosts: FixedCostRow[];
  tenants: { id: string; name: string }[];
};

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function platformAccounting(period?: string): Promise<PlatformAccounting> {
  await platformOnly();
  return engine<PlatformAccounting>(`/billing/accounting${period && PERIOD.test(period) ? `?period=${period}` : ""}`);
}

const back = (tab: string, msg: string, error = false) => "/platform?tab=" + tab + "&msg=" + encodeURIComponent(msg) + (error ? "&kind=error" : "");
const dollars = (v: FormDataEntryValue | null) => Math.round((Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0) * 100);

export async function saveFixedCost(formData: FormData) {
  const s = await platformOnly();
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const body = {
    id: str("id") || null,
    tenantId: str("tenantId") || null,
    vendor: str("vendor"),
    kind: str("kind") || "subscription",
    label: str("label"),
    amountCents: Math.max(0, dollars(formData.get("amount"))),
    cadence: str("cadence") === "ONCE" ? "ONCE" : "MONTHLY",
    startPeriod: str("startPeriod"),
    endPeriod: str("endPeriod") || null,
    note: str("note") || null,
  };
  try {
    await engine("/billing/fixed-costs", { method: "POST", body: JSON.stringify(body) });
    await prisma.auditLog.create({ data: { tenantId: s.actingFrom?.id ?? s.tenant.id, actorId: s.user.id, action: "billing.fixed_cost.save", target: body.id ?? body.label, after: body } });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    redirect(back("costs", m.match(/"error":"(.*)"\}$/)?.[1] ?? m, true));
  }
  revalidatePath("/platform");
  redirect(back("costs", `Saved "${body.label}".`));
}

export async function deleteFixedCost(formData: FormData) {
  const s = await platformOnly();
  const id = String(formData.get("id"));
  await engine("/billing/fixed-costs/delete", { method: "POST", body: JSON.stringify({ id }) });
  await prisma.auditLog.create({ data: { tenantId: s.actingFrom?.id ?? s.tenant.id, actorId: s.user.id, action: "billing.fixed_cost.delete", target: id } });
  revalidatePath("/platform");
  redirect(back("costs", "Fixed cost removed, with the months it had written."));
}

export async function saveAccountingSettings(formData: FormData) {
  await platformOnly();
  const n = (k: string) => Number(String(formData.get(k) ?? "").replace(/[^0-9.]/g, "")) || 0;
  await engine("/billing/accounting/settings", {
    method: "POST",
    body: JSON.stringify({
      costAllocation: formData.get("costAllocation") === "SEATS" ? "SEATS" : "MINUTES",
      allocateUnattributed: formData.get("allocateUnattributed") === "on",
      marginFloorPct: Math.min(100, Math.round(n("marginFloorPct"))),
      ttsCostMillicentsPerKChar: Math.round(n("ttsCost") * 1000),
    }),
  });
  revalidatePath("/platform");
  redirect(back("costs", "Accounting settings saved."));
}

export async function saveVendorAccount(formData: FormData) {
  await platformOnly();
  const raw = (k: string) => String(formData.get(k) ?? "").trim();
  const vendor = raw("vendor");
  const low = raw("low");
  const bal = raw("balance");
  await engine("/billing/vendor-account", {
    method: "POST",
    body: JSON.stringify({
      vendor,
      lowBalanceCents: low === "" ? null : Math.max(0, dollars(low)),
      // Only vendors with no balance API take a typed balance; blank clears it.
      ...(formData.has("balance") ? { balanceCents: bal === "" ? null : dollars(bal) } : {}),
    }),
  });
  revalidatePath("/platform");
  redirect(back("accounting", `Saved ${vendor}.`) + "#balances");
}

export async function createWorkspace(formData: FormData) {
  const s = await platformOnly();
  const name = String(formData.get("name") ?? "").trim();
  const adminEmail = String(formData.get("adminEmail") ?? "").trim().toLowerCase() || null;
  const r = await engine<{ ok: boolean; id: string; slug: string; emailed?: boolean }>("/workspaces", { method: "POST", body: JSON.stringify({ name, adminEmail }) });
  await prisma.auditLog.create({ data: { tenantId: s.actingFrom?.id ?? s.tenant.id, actorId: s.user.id, action: "workspace.create", target: r.id, after: { name, adminEmail, welcomeEmailed: Boolean(r.emailed) } } });
  revalidatePath("/platform");
  const who = adminEmail ? (r.emailed ? `; ${adminEmail} was emailed a sign-in link that opens the setup wizard` : `; ${adminEmail} can sign in as its admin (no welcome email: the setup wizard is paused, or Crossbar email is not set up)`) : "";
  redirect("/platform?tab=clients&msg=" + encodeURIComponent(`Workspace "${name}" created${who}.`));
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
  // "Open wizard" on /platform: straight to the client's onboarding wizard.
  redirect(formData.get("next") === "/welcome" ? "/welcome" : "/dashboard");
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
      aiMinutePriceMillicents: Math.round(n("aiMinutePrice") * 1000),
      transcriptMinutePriceMillicents: Math.round(n("transcriptMinutePrice") * 1000),
      assistCallPriceMillicents: Math.round(n("assistCallPrice") * 1000),
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
      aiMinuteCostMillicents: Math.round(n("aiMinuteCost") * 1000),
      sttMinuteCostMillicents: Math.round(n("sttMinuteCost") * 1000),
      prepayInstructions: String(formData.get("prepayInstructions") ?? "").trim() || null,
    }),
  });
  revalidatePath("/platform");
  revalidatePath("/billing");
}
