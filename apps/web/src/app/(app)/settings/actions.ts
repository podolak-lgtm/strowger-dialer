"use server";

import { prisma, type AudioKind } from "@strowger/db";
import { normalizePhone, stateForAreaCode } from "@strowger/shared";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

export async function addAudioAsset(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "OTHER") as AudioKind;
  const url = String(formData.get("url") ?? "").trim();
  if (!name || !/^https:\/\//.test(url)) throw new Error("Name and an https URL are required");
  await prisma.audioAsset.create({ data: { tenantId: s.tenant.id, name, kind, storageUrl: url } });
  revalidatePath("/settings");
}

export async function deleteAudioAsset(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  await prisma.audioAsset.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/settings");
}

export async function setCampaignAudio(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id } });
  if (!c) throw new Error("Unknown campaign");
  const pick = (k: string) => String(formData.get(k) ?? "") || null;
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { safeHarborAudioId: pick("safeHarborAudioId"), voicemailDropAudioId: pick("voicemailDropAudioId"), screenerAudioId: pick("screenerAudioId"), disclosureAudioId: pick("disclosureAudioId") },
  });
  revalidatePath("/settings");
}

export async function addCallerIds(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const raw = String(formData.get("numbers") ?? "");
  const rows = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const phone = normalizePhone(token);
    if (!phone) continue;
    const areaCode = phone.slice(0, 3);
    rows.push({ tenantId: s.tenant.id, phone, areaCode, state: stateForAreaCode(areaCode), smsEnabled: formData.get("smsEnabled") === "on" });
  }
  if (rows.length) await prisma.callerIdNumber.createMany({ data: rows, skipDuplicates: true });
  revalidatePath("/settings");
}

export async function setCallerIdStatus(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const status = String(formData.get("status")) as "ACTIVE" | "RESTING" | "SPAM_FLAGGED" | "RETIRED";
  await prisma.callerIdNumber.updateMany({ where: { id, tenantId: s.tenant.id }, data: { status } });
  revalidatePath("/settings");
}
