"use server";

import { Prisma, prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

async function ownCampaign(id: string) {
  const s = await requireRole("SUPERVISOR");
  const c = await prisma.campaign.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!c) throw new Error("Unknown campaign");
  return { s, c };
}

/** New order of the campaign's lists, top first. Priority becomes the rank. */
export async function reorderLists(campaignId: string, listIds: string[]): Promise<{ ok: boolean }> {
  const { s } = await ownCampaign(campaignId);
  const lists = await prisma.list.findMany({ where: { campaignId, tenantId: s.tenant.id }, select: { id: true } });
  const known = new Set(lists.map((l) => l.id));
  const ordered = listIds.filter((id) => known.has(id));
  await prisma.$transaction(ordered.map((id, i) => prisma.list.update({ where: { id }, data: { priority: i + 1 } })));
  revalidatePath(`/campaigns/${campaignId}/builder`);
  return { ok: true };
}

export async function saveSchedule(campaignId: string, grid: boolean[][] | null): Promise<{ ok: boolean }> {
  const { c } = await ownCampaign(campaignId);
  const valid = grid && grid.length === 7 && grid.every((r) => r.length === 24);
  await prisma.campaign.update({ where: { id: c.id }, data: { allowedHours: valid ? (grid as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  revalidatePath(`/campaigns/${campaignId}/builder`);
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

export async function saveRules(campaignId: string, rules: { maxAttemptsPerDay: number; listSelection: "STRICT_PRIORITY" | "WEIGHTED_ROUND_ROBIN" }): Promise<{ ok: boolean }> {
  const { c } = await ownCampaign(campaignId);
  await prisma.campaign.update({ where: { id: c.id }, data: { maxAttemptsPerDay: Math.max(1, Math.min(10, rules.maxAttemptsPerDay)), listSelection: rules.listSelection } });
  revalidatePath(`/campaigns/${campaignId}/builder`);
  return { ok: true };
}

export async function setListCadence(campaignId: string, listId: string, cadenceProfileId: string | null): Promise<{ ok: boolean }> {
  const { s } = await ownCampaign(campaignId);
  if (cadenceProfileId) {
    const ok = await prisma.cadenceProfile.findFirst({ where: { id: cadenceProfileId, tenantId: s.tenant.id }, select: { id: true } });
    if (!ok) throw new Error("Unknown cadence");
  }
  await prisma.list.updateMany({ where: { id: listId, campaignId, tenantId: s.tenant.id }, data: { cadenceProfileId } });
  revalidatePath(`/campaigns/${campaignId}/builder`);
  return { ok: true };
}

export async function attachList(campaignId: string, listId: string): Promise<{ ok: boolean }> {
  const { s } = await ownCampaign(campaignId);
  const max = await prisma.list.aggregate({ where: { campaignId }, _max: { priority: true } });
  await prisma.list.updateMany({ where: { id: listId, tenantId: s.tenant.id }, data: { campaignId, priority: (max._max.priority ?? 0) + 1 } });
  revalidatePath(`/campaigns/${campaignId}/builder`);
  return { ok: true };
}

export async function launchCampaign(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  const { s, c } = await ownCampaign(campaignId);
  const lists = await prisma.list.count({ where: { campaignId, status: "ACTIVE" } });
  if (lists === 0) return { ok: false, error: "Attach at least one active list first" };
  await prisma.campaign.update({ where: { id: c.id }, data: { status: "ACTIVE" } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.launch", target: c.id } });
  revalidatePath(`/campaigns/${campaignId}/builder`);
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  return { ok: true };
}
