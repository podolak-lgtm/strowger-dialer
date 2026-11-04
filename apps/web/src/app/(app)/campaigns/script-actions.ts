"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

/** Save the campaign script as a new version; the newest active version is what agents see. */
export async function saveScript(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const body = String(formData.get("body") ?? "").trim();
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  const last = await prisma.script.findFirst({ where: { campaignId }, orderBy: { version: "desc" } });
  if (last && last.body === body) return;
  await prisma.script.create({ data: { tenantId: s.tenant.id, campaignId, version: (last?.version ?? 0) + 1, body, active: body.length > 0 } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "script.save", target: campaignId, after: { version: (last?.version ?? 0) + 1 } } });
  revalidatePath(`/campaigns/${campaignId}`);
}
