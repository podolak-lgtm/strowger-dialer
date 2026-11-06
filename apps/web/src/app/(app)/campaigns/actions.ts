"use server";

import { prisma, type DialMode } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseDialPlan, parseDisposition } from "@strowger/shared/campaign-form";
import { requireRole } from "@/lib/auth";
import { campaignSettingsData, returnNumbersToPool } from "./campaign-data";
import { createCampaignRecord } from "@/lib/campaign-create";


export async function createCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  const dialMode = String(formData.get("dialMode") ?? "PREVIEW") as DialMode;
  if (!name) throw new Error("Name is required");
  const c = await createCampaignRecord(s.tenant, { name, dialMode });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.create", target: c.id, after: { name, dialMode } } });
  // The wizard goes on to the first list and its numbers (owner, 6 Nov).
  redirect(`/campaigns/${c.id}/setup`);
}

const formGet = (formData: FormData) => (k: string) => {
  const v = formData.get(k);
  return v === null ? null : String(v);
};

export async function updateCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const before = await prisma.campaign.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!before) throw new Error("Unknown campaign");
  const data = campaignSettingsData(formGet(formData), before);
  await prisma.campaign.update({ where: { id }, data });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.update", target: id, before: before as object, after: data } });
  if (data.status === "ARCHIVED" && before.status !== "ARCHIVED") {
    const moved = await returnNumbersToPool(prisma, s.tenant.id, id);
    if (moved) await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.numbers_to_pool", target: id, after: { count: moved } } });
  }
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
}

export async function saveDialPlan(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const id = String(formData.get("planId") ?? "");
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  const data = { tenantId: s.tenant.id, campaignId, ...parseDialPlan(formGet(formData)) };
  if (id) await prisma.dialPlan.update({ where: { id }, data });
  else await prisma.dialPlan.create({ data });
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function deleteDialPlan(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("planId"));
  const plan = await prisma.dialPlan.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!plan) return;
  await prisma.dialPlan.delete({ where: { id } });
  revalidatePath(`/campaigns/${plan.campaignId}`);
}

export async function saveDisposition(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const id = String(formData.get("dispositionId") ?? "");
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  const data = { tenantId: s.tenant.id, campaignId, ...parseDisposition(formGet(formData)) };
  if (id) await prisma.disposition.update({ where: { id }, data });
  else await prisma.disposition.create({ data: { ...data, sortOrder: 99 } });
  revalidatePath(`/campaigns/${campaignId}`);
}
