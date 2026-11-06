"use server";

import { prisma, type DialMode } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseDialPlan, parseDisposition } from "@strowger/shared/campaign-form";
import { requireRole } from "@/lib/auth";
import { campaignSettingsData, returnNumbersToPool } from "./campaign-data";

const DEFAULT_DISPOSITIONS = [
  { code: "SALE", label: "Sale", isContact: true, isSale: true, hotkey: "1" },
  { code: "CB", label: "Callback", isContact: true, isCallback: true, hotkey: "2" },
  { code: "NI", label: "Not interested", isContact: true, hotkey: "3" },
  { code: "NA", label: "No answer", recycleAfterMinutes: 180, hotkey: "4" },
  { code: "VM", label: "Voicemail", recycleAfterMinutes: 240, hotkey: "5" },
  { code: "BUSY", label: "Busy", recycleAfterMinutes: 60, hotkey: "6" },
  { code: "WN", label: "Wrong number", hotkey: "7" },
  { code: "DNC", label: "Do not call", isContact: true, isDnc: true, hotkey: "9" },
];

export async function createCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  const dialMode = String(formData.get("dialMode") ?? "PREVIEW") as DialMode;
  if (!name) throw new Error("Name is required");
  // Games defaults (Settings → Games); bets stay off until switched on for the campaign.
  const g = ((s.tenant.settings ?? {}) as { games?: { weeklyPoints?: number; maxStake?: number } }).games ?? {};
  const c = await prisma.campaign.create({
    data: {
      tenantId: s.tenant.id,
      name,
      dialMode,
      weeklyPoints: Math.max(0, Math.min(1_000_000, Number(g.weeklyPoints) || 10_000)),
      maxStake: Math.max(1, Math.min(1_000_000, Number(g.maxStake) || 5_000)),
      dispositions: { create: DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, tenantId: s.tenant.id, sortOrder: i })) },
      dialPlans: {
        create: [
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 0, ageToDays: 0, attemptsPerDay: 3, retryGapMinutes: 60, weight: 100 },
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 1, ageToDays: 7, attemptsPerDay: 2, retryGapMinutes: 180, weight: 50 },
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 8, ageToDays: null, attemptsPerDay: 1, retryGapMinutes: 1440, weight: 10 },
        ],
      },
    },
  });
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
