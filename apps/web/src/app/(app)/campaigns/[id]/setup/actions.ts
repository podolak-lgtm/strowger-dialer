"use server";

// New campaign setup (owner, 6 Nov): after "Create campaign", load or pick the
// first list, then order and match its numbers.
import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

async function ownCampaign(tenantId: string, campaignId: string) {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true, name: true } });
  if (!c) throw new Error("Unknown campaign");
  return c;
}

/** A new upload list attached to the campaign; the page then shows the CSV wizard. */
export async function createFirstList(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const c = await ownCampaign(s.tenant.id, String(formData.get("campaignId")));
  const name = String(formData.get("name") ?? "").trim() || `${c.name} leads`;
  if (await prisma.list.findFirst({ where: { tenantId: s.tenant.id, name }, select: { id: true } })) {
    redirect(`/campaigns/${c.id}/setup?error=${encodeURIComponent(`A list called "${name}" already exists; pick another name or use it below.`)}`);
  }
  const list = await prisma.list.create({ data: { tenantId: s.tenant.id, name, campaignId: c.id, source: "UPLOAD" } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "list.create", target: list.id, after: { name, campaignId: c.id, from: "campaign.setup" } } });
  revalidatePath("/lists");
  redirect(`/campaigns/${c.id}/setup?list=${list.id}`);
}

/** An existing list moves into the campaign (a list belongs to one campaign at a time). */
export async function attachFirstList(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const c = await ownCampaign(s.tenant.id, String(formData.get("campaignId")));
  const listId = String(formData.get("listId") ?? "");
  const list = await prisma.list.findFirst({ where: { id: listId, tenantId: s.tenant.id }, select: { id: true, campaignId: true } });
  if (!list) redirect(`/campaigns/${c.id}/setup?error=${encodeURIComponent("Pick a list")}`);
  await prisma.list.update({ where: { id: list.id }, data: { campaignId: c.id } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "list.update", target: list.id, before: { campaignId: list.campaignId }, after: { campaignId: c.id, from: "campaign.setup" } } });
  revalidatePath("/lists");
  revalidatePath(`/campaigns/${c.id}`);
  redirect(`/campaigns/${c.id}/setup?list=${list.id}`);
}
