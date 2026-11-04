"use server";

import { prisma, type DuplicateAction, type ListStatus } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

export async function createList(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  if (!name) throw new Error("Name is required");
  if (campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
    if (!c) throw new Error("Unknown campaign");
  }
  const list = await prisma.list.create({ data: { tenantId: s.tenant.id, name, campaignId, source: "UPLOAD" } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "list.create", target: list.id, after: { name, campaignId } } });
  redirect(`/lists/${list.id}`);
}

export async function updateList(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  const duplicateAction = String(formData.get("duplicateAction")) as DuplicateAction;
  const status = String(formData.get("status")) as ListStatus;
  const before = await prisma.list.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!before) throw new Error("Unknown list");
  if (campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
    if (!c) throw new Error("Unknown campaign");
  }
  // A list belongs to one campaign at a time: setting campaignId moves it.
  await prisma.list.update({ where: { id }, data: { campaignId, duplicateAction, status } });
  await prisma.auditLog.create({
    data: {
      tenantId: s.tenant.id,
      actorId: s.user.id,
      action: "list.update",
      target: id,
      before: { campaignId: before.campaignId, duplicateAction: before.duplicateAction, status: before.status },
      after: { campaignId, duplicateAction, status },
    },
  });
  revalidatePath(`/lists/${id}`);
  revalidatePath("/lists");
}
