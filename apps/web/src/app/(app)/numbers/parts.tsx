import type { ReactNode } from "react";
import { engine } from "@/lib/engine";
import { Notice } from "@/components/ui";

// Shared by the Numbers section's tabs (/numbers, /numbers/order,
// /numbers/texting, /numbers/carrier), which were one page until 7 Nov.

export type ProvisionStatus = {
  telnyx: boolean;
  jambonz: boolean;
  sbcFqdn: string;
  smsWebhook: string;
  carrierName: string;
  connection: { id: string; name: string; fqdn: string | null } | null;
  outboundProfileId: string | null;
  messagingProfile: { id: string; name: string; webhook: string | null } | null;
  carrier: { sid: string; name: string; gateways: number } | null;
  counts: Record<string, number>;
  missing: string[];
};
export type Found = { phone: string; e164: string; city: string | null; state: string | null; monthly: string | null; upfront: string | null; features: string[] };
export type TenDlc = {
  brandId: string | null;
  campaignId: string | null;
  messagingProfileId: string | null;
  brand: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
  numbersAssigned: number | null;
};

export type SearchParams = Record<string, string | string[] | undefined>;
export const param = (sp: SearchParams, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");

/** The engine's view of the carrier setup; `error` when the engine did not answer. */
export async function provisionStatus(tenantId: string): Promise<{ status: ProvisionStatus | null; error: string | null }> {
  try {
    return { status: await engine<ProvisionStatus>(`/provision/status?tenantId=${tenantId}`), error: null };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export const setupComplete = (status: ProvisionStatus | null) => Boolean(status?.connection && status?.carrier && status?.messagingProfile);

export function statusTone(s: string): "zinc" | "green" | "amber" | "red" | "blue" {
  if (s === "ready") return "green";
  if (s === "voice") return "blue";
  if (s === "ordered") return "amber";
  if (s === "failed") return "red";
  return "zinc";
}
export function tenDlcTone(s: string | undefined): "zinc" | "green" | "amber" | "red" {
  if (!s) return "zinc";
  if (/PROVISIONED|ACCEPTED|VERIFIED|^OK$/.test(s)) return "green";
  if (/FAIL|REJECT|SUSPEND|EXPIRED/.test(s)) return "red";
  return "amber";
}

/** The `?msg=&kind=` an action redirected back with, and the engine error if any. */
export function Flash({ sp, engineError }: { sp: SearchParams; engineError?: string | null }) {
  const msg = param(sp, "msg");
  return (
    <>
      {msg ? <Notice kind={param(sp, "kind") === "error" ? "error" : "ok"}>{msg}</Notice> : null}
      {engineError ? <Notice kind="error">The engine did not answer: {engineError}</Notice> : null}
    </>
  );
}

export function Row({ ok, label, children }: { ok: boolean; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${ok ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>{ok ? "✓" : "·"}</span>
      <div className="min-w-0">
        <div className="font-medium text-zinc-200">{label}</div>
        <div className="break-words text-xs text-zinc-400">{children}</div>
      </div>
    </div>
  );
}
