"use server";

// Number planning (owner, 6 Nov): the "Numbers for this list" card on the
// import report, the list page, the campaign's Dialing tab and the new
// campaign setup asks the engine for a plan and applies it. Applying is an
// immediate action (it pins pool numbers and buys numbers), never part of the
// campaign draft.
import { prisma } from "@strowger/db";
import type { DidPlan } from "@strowger/shared/did-plan";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

export interface PlanView {
  plan: DidPlan;
  campaign: { id: string; name: string; callerIdMode: string; callerIdFallback: string; status: string };
  list: { id: string; name: string } | null;
  lists: number;
  unregistered: number;
  notes: string[];
}
export interface ApplyResult {
  taken: { phone: string; areaCode: string; forAreaCode: string }[];
  ordered: { areaCode: string; requested: string; phones: string[] }[];
  short: { areaCode: string; count: number; reason: string }[];
  error?: string;
}
export interface PlanOpts {
  poolFirst: boolean;
  exactOnly: boolean;
}

const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.match(/\{"error":"(.*)"\}$/);
  return j ? j[1]!.replace(/\\"/g, '"') : m;
};

export async function getDidPlan(campaignId: string, listId: string | null, opts: PlanOpts): Promise<{ ok: true; view: PlanView } | { ok: false; error: string }> {
  const s = await requireRole("SUPERVISOR");
  const q = new URLSearchParams({ tenantId: s.tenant.id, poolFirst: String(opts.poolFirst), exactOnly: String(opts.exactOnly) });
  if (listId) q.set("listId", listId);
  try {
    return { ok: true, view: await engine<PlanView>(`/campaigns/${encodeURIComponent(campaignId)}/did-plan?${q.toString()}`) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function applyDidPlan(campaignId: string, listId: string | null, opts: PlanOpts): Promise<{ ok: true; result: ApplyResult } | { ok: false; error: string }> {
  const s = await requireRole("SUPERVISOR");
  try {
    const result = await engine<ApplyResult>(`/campaigns/${encodeURIComponent(campaignId)}/did-plan/apply`, {
      method: "POST",
      body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, listId, poolFirst: opts.poolFirst, exactOnly: opts.exactOnly, requestedBy: s.user.email }),
    });
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/numbers");
    revalidatePath("/dids");
    if (listId) revalidatePath(`/lists/${listId}`);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** Idle pool numbers the person picked go back to Telnyx (and stop costing a monthly fee). */
export async function releaseIdle(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const ids = formData.getAll("ids").map(String);
  let released = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const n = await prisma.callerIdNumber.findFirst({ where: { id, tenantId: s.tenant.id, campaignId: null }, select: { id: true, phone: true } });
    if (!n) continue;
    try {
      await engine("/provision/release", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, id }) });
      released++;
    } catch (e) {
      unstable_rethrow(e);
      failed.push(`${n.phone}: ${errText(e)}`);
    }
  }
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.release_idle", after: { requested: ids.length, released, failed } } });
  revalidatePath("/numbers");
  revalidatePath("/dids");
  const msg = failed.length ? `Released ${released}; not released: ${failed.join("; ")}` : `Released ${released} idle number(s) back to Telnyx.`;
  redirect(`/numbers?${new URLSearchParams({ msg, kind: failed.length ? "error" : "ok" }).toString()}`);
}
