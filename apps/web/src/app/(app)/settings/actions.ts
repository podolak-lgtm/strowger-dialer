"use server";

import { prisma, type AudioKind } from "@strowger/db";
import { normalizePhone, stateForAreaCode } from "@strowger/shared";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { mediaUrl, putObject, storageConfigured } from "@/lib/storage";
import { randomBytes } from "node:crypto";

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

export async function saveGoals(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const n = (k: string, d: number) => Math.max(1, Number(formData.get(k)) || d);
  const settings = (s.tenant.settings ?? {}) as Record<string, unknown>;
  await prisma.tenant.update({ where: { id: s.tenant.id }, data: { settings: { ...settings, goals: { dials: n("dials", 200), contacts: n("contacts", 20), sales: n("sales", 3) } } } });
  revalidatePath("/settings");
}

/** Upload an audio file to the media bucket and register it as a prompt. */
export async function uploadAudio(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  if (!storageConfigured) throw new Error("Media storage is not configured on this install");
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "OTHER") as AudioKind;
  const file = formData.get("file");
  if (!name || !(file instanceof File) || file.size === 0) throw new Error("Name and a file are required");
  if (file.size > 20 * 1024 * 1024) throw new Error("Keep prompts under 20 MB");
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const type = ext === "wav" ? "audio/wav" : ext === "mp3" ? "audio/mpeg" : file.type || "application/octet-stream";
  if (!/^audio\//.test(type)) throw new Error("Upload a WAV or MP3");
  const key = `audio/${s.tenant.id}/${randomBytes(12).toString("base64url")}.${ext || "wav"}`;
  await putObject(key, Buffer.from(await file.arrayBuffer()), type);
  await prisma.audioAsset.create({ data: { tenantId: s.tenant.id, name, kind, storageUrl: mediaUrl(key) } });
  revalidatePath("/settings");
}
