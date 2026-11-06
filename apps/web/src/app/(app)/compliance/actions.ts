"use server";

import { prisma, type DncScope } from "@strowger/db";
import { normalizePhone } from "@strowger/shared";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

/** Add numbers to the DNC list, one per line or comma-separated. Returns counts. */
export async function addDncNumbers(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const scope = String(formData.get("scope") ?? "SYSTEM") as DncScope;
  const campaignId = scope === "CAMPAIGN" ? String(formData.get("campaignId") ?? "") || null : null;
  if (scope === "CAMPAIGN" && !campaignId) throw new Error("Pick a campaign for a campaign-scoped entry");
  const note = String(formData.get("note") ?? "").trim() || null;
  const raw = String(formData.get("numbers") ?? "");
  const phones = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    const p = normalizePhone(token);
    if (p) phones.add(p);
  }
  if (phones.size === 0) return;

  const rows = [...phones].map((phone) => ({ tenantId: s.tenant.id, phone, scope, campaignId, source: "MANUAL" as const, note }));
  await prisma.dncEntry.createMany({ data: rows, skipDuplicates: true });

  // Any lead already loaded with one of these numbers stops being dialable.
  await prisma.lead.updateMany({
    where: {
      tenantId: s.tenant.id,
      phone: { in: [...phones] },
      status: { notIn: ["DNC", "BLOCKED", "FINISHED"] },
      ...(campaignId ? { list: { campaignId } } : {}),
    },
    data: { status: "DNC", scrubStatus: "DNC", scrubReason: "Added to do-not-call list", scrubbedAt: new Date(), nextDialAt: null },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "dnc.add", after: { count: phones.size, scope, campaignId } } });
  revalidatePath("/compliance");
}

export async function removeDncEntry(formData: FormData) {
  const s = await requireRole("ADMIN");
  const id = String(formData.get("id"));
  const row = await prisma.dncEntry.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!row) return;
  await prisma.dncEntry.delete({ where: { id } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "dnc.remove", target: id, before: { phone: row.phone, scope: row.scope } } });
  revalidatePath("/compliance");
}

export async function markStateRuleVerified(formData: FormData) {
  const s = await requireRole("ADMIN");
  const state = String(formData.get("state"));
  const verified = formData.get("verified") === "true";
  await prisma.stateRule.update({ where: { state }, data: { verifiedAt: verified ? new Date() : null } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "state_rule.verify", target: state, after: { verified } } });
  revalidatePath("/compliance");
}

export async function runScrubNow() {
  const s = await requireRole("SUPERVISOR");
  const { engine } = await import("@/lib/engine");
  await engine("/scrub/run", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) }).catch(() => undefined);
  revalidatePath("/compliance");
}

export async function setScrubRequired(formData: FormData) {
  const s = await requireRole("ADMIN");
  const on = formData.get("on") === "true";
  const settings = (s.tenant.settings ?? {}) as Record<string, unknown>;
  await prisma.tenant.update({ where: { id: s.tenant.id }, data: { settings: { ...settings, scrubRequired: on } } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "scrub.required", after: { on } } });
  revalidatePath("/compliance");
}

export type NumberCheck = {
  phone: string;
  ourDnc: Array<{ scope: string; campaign: string | null; source: string; note: string | null; addedAt: string }>;
  leads: Array<{ id: string; name: string; status: string; scrubStatus: string; list: string | null }>;
  crossbar: { checked: true; paid: boolean; flagged: Array<{ kind: string; source: string }>; unresolved: boolean } | { checked: false; error: string };
  verdict: "BLOCKED" | "CLEAR" | "UNKNOWN";
  reasons: string[];
};

/** One number against our DNC, its leads and Crossbar's scrub (litigators, complainers). The engine holds the Crossbar key. */
export async function checkNumber(phone: string, paid: boolean): Promise<{ ok: true; result: NumberCheck } | { ok: false; error: string }> {
  const s = await requireRole("SUPERVISOR");
  try {
    return await engine<{ ok: true; result: NumberCheck } | { ok: false; error: string }>("/compliance/check", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, phone, paid }) });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
