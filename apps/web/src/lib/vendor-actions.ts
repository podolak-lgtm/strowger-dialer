"use server";

// /platform → Balances, "Vendor connections" (owner, 6 Nov). Platform admins only. Credentials go straight to the
// engine, which seals them under VENDOR_SECRETS_KEY; nothing saved ever comes back here except a hint
// ("saved, ending …1234"). The invoice upload is a route handler (/api/platform/vendor-invoice), not an action,
// because Server Action bodies are capped at 1 MB.
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

async function platformAdmin() {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) throw new Error("Platform workspace only");
  return { tenantId: s.actingFrom?.id ?? s.tenant.id, userId: s.user.id };
}

export type VendorProgress = { state: "running" | "done" | "failed" | "needs_person"; step: string; log: { at: string; line: string }[]; startedAt: string; finishedAt?: string };
export type VendorConnectionView = {
  vendor: string;
  label: string;
  method: "api" | "browser" | "api+browser";
  collects: string;
  whereToGet: string;
  fields: { key: string; label: string; secret: boolean; optional: boolean; hint: string | null }[];
  missing: string | null;
  nightly: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastScreenshotKey: string | null;
  progress: VendorProgress | null;
  invoiceMode: "replaces" | "reconcile";
  balanceCents: number | null;
  lowBalanceCents: number | null;
};
export type VendorInvoiceView = { id: string; vendor: string; period: string; ref: string; invoiceNumber: string | null; origin: string; fileKey: string | null; totalCents: number | null; currency: string | null; status: string; error: string | null; lineCount: number; at: string };
export type VendorConnections = { secretsConfigured: boolean; invoiceReadingConfigured: boolean; bucketConfigured: boolean; connectors: VendorConnectionView[]; invoices: VendorInvoiceView[] };

export async function vendorConnections(): Promise<VendorConnections | null> {
  await platformAdmin();
  try {
    return await engine<VendorConnections>("/billing/connections");
  } catch {
    return null;
  }
}

export async function saveVendorConnection(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const actor = await platformAdmin();
  const vendor = String(formData.get("vendor") ?? "");
  const values: Record<string, string> = {};
  const clear: string[] = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("f:") && typeof v === "string" && v.trim()) values[k.slice(2)] = v;
    if (k.startsWith("clear:") && v === "on") clear.push(k.slice(6));
  }
  try {
    await engine("/billing/connections", { method: "POST", body: JSON.stringify({ vendor, values, clear, actor }) });
    revalidatePath("/platform");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: engineError(e) };
  }
}

export async function setVendorNightly(vendor: string, nightly: boolean): Promise<{ ok: boolean; error?: string }> {
  const actor = await platformAdmin();
  try {
    await engine("/billing/connections/nightly", { method: "POST", body: JSON.stringify({ vendor, nightly, actor }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: engineError(e) };
  }
}

export async function collectVendorNow(vendor: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await platformAdmin();
  try {
    await engine("/billing/connections/collect", { method: "POST", body: JSON.stringify({ vendor, actor }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: engineError(e) };
  }
}

/** The engine's `{ error }` message rather than the whole response line. */
function engineError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const json = /\{.*\}$/.exec(msg)?.[0];
  if (json) {
    try {
      const body = JSON.parse(json) as { error?: string; message?: string };
      return body.error ?? body.message ?? msg;
    } catch {
      /* fall through */
    }
  }
  return msg.slice(0, 300);
}
