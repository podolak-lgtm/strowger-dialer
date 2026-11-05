"use server";

// Transfer destinations (owner, 5 Nov): per campaign, the numbers an agent can
// hand a live lead to. Add, edit, reorder, deactivate, copy from another
// campaign. The engine's dialer/transfers.ts does the dialling.
import { prisma } from "@strowger/db";
import { STATIC_CALLER_ID_NOT_OURS, parseTransferDestination } from "@strowger/shared/campaign-form";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { ownsActiveNumber } from "./campaign-data";

async function ownCampaign(tenantId: string, campaignId: string) {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  return c;
}

export async function saveTransferDestination(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId") ?? "");
  const id = String(formData.get("destinationId") ?? "");
  await ownCampaign(s.tenant.id, campaignId);
  const parsed = parseTransferDestination((k) => {
    const v = formData.get(k);
    return v === null ? null : String(v);
  });
  const { name, phone, type, callerIdMode } = parsed;
  if (parsed.staticCallerId && !(await ownsActiveNumber(prisma, s.tenant.id, parsed.staticCallerId))) throw new Error(STATIC_CALLER_ID_NOT_OURS);
  const data = { tenantId: s.tenant.id, campaignId, ...parsed } as const;
  if (id) {
    const existing = await prisma.transferDestination.findFirst({ where: { id, tenantId: s.tenant.id, campaignId } });
    if (!existing) throw new Error("Unknown destination");
    await prisma.transferDestination.update({ where: { id }, data });
  } else {
    const last = await prisma.transferDestination.findFirst({ where: { campaignId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    await prisma.transferDestination.create({ data: { ...data, sortOrder: (last?.sortOrder ?? -1) + 1 } });
  }
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: id ? "transfer_destination.update" : "transfer_destination.create", target: campaignId, after: { name, phone, type, callerIdMode } } });
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function toggleTransferDestination(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id") ?? "");
  const d = await prisma.transferDestination.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!d) return;
  await prisma.transferDestination.update({ where: { id }, data: { active: !d.active } });
  revalidatePath(`/campaigns/${d.campaignId}`);
}

export async function deleteTransferDestination(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id") ?? "");
  const d = await prisma.transferDestination.findFirst({ where: { id, tenantId: s.tenant.id }, include: { _count: { select: { transfers: true } } } });
  if (!d) return;
  // Keep the history: a destination that has been used is deactivated, never deleted.
  if (d._count.transfers > 0) await prisma.transferDestination.update({ where: { id }, data: { active: false } });
  else await prisma.transferDestination.delete({ where: { id } });
  revalidatePath(`/campaigns/${d.campaignId}`);
}

/** Swap with the neighbour above or below. */
export async function moveTransferDestination(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id") ?? "");
  const dir = String(formData.get("dir")) === "up" ? -1 : 1;
  const d = await prisma.transferDestination.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!d) return;
  const all = await prisma.transferDestination.findMany({ where: { campaignId: d.campaignId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const i = all.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= all.length) return;
  const order = all.map((x) => x.id);
  [order[i], order[j]] = [order[j]!, order[i]!];
  await prisma.$transaction(order.map((x, k) => prisma.transferDestination.update({ where: { id: x }, data: { sortOrder: k } })));
  revalidatePath(`/campaigns/${d.campaignId}`);
}

/** Copy another campaign's active destinations onto this one (names already here are skipped). */
export async function copyTransferDestinations(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId") ?? "");
  const fromId = String(formData.get("fromCampaignId") ?? "");
  await ownCampaign(s.tenant.id, campaignId);
  if (!fromId || fromId === campaignId) throw new Error("Pick another campaign to copy from");
  await ownCampaign(s.tenant.id, fromId);
  const [source, existing] = await Promise.all([
    prisma.transferDestination.findMany({ where: { campaignId: fromId, tenantId: s.tenant.id, active: true }, orderBy: { sortOrder: "asc" } }),
    prisma.transferDestination.findMany({ where: { campaignId }, select: { name: true, sortOrder: true } }),
  ]);
  const have = new Set(existing.map((d) => d.name.toLowerCase()));
  let sortOrder = existing.reduce((n, d) => Math.max(n, d.sortOrder), -1) + 1;
  const rows = source
    .filter((d) => !have.has(d.name.toLowerCase()))
    .map((d) => ({ tenantId: s.tenant.id, campaignId, name: d.name, phone: d.phone, type: d.type, callerIdMode: d.callerIdMode, staticCallerId: d.staticCallerId, whisperOn: d.whisperOn, whisperText: d.whisperText, sortOrder: sortOrder++ }));
  if (rows.length) await prisma.transferDestination.createMany({ data: rows });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "transfer_destination.copy", target: campaignId, after: { fromCampaignId: fromId, copied: rows.length } } });
  revalidatePath(`/campaigns/${campaignId}`);
}
