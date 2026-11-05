"use server";

import { requireRole, requireSession } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { revalidatePath } from "next/cache";

export type BillingStatus = {
  isPlatform: boolean;
  balanceCents: number;
  lowBalanceCents: number;
  low: boolean;
  critical: boolean;
  suspended: boolean;
  graceDays: number;
  zeroSince: string | null;
  dailyAvgCents: number;
  runwayDays: number | null;
  rates: { seatMonthlyCents: number; perMinuteMillicents: number; didMarkupPct: number; scrubMarginMillicents: number; smsPriceMillicents: number };
};
export type BillingOverview = {
  period: string;
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
  if (!s.tenant.isPlatform) throw new Error("Platform workspace only");
  return s;
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
