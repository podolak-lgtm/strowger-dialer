"use server";

import { prisma, type CarrierVerdict } from "@strowger/db";
import { normalizePhone, stateForAreaCode } from "@strowger/shared";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { recordReading, scanNumbers } from "@/lib/did-reputation";

const VERDICTS: CarrierVerdict[] = ["GOOD", "FLAGGED", "SPAM", "BLOCKED", "UNKNOWN"];
const v = (x: unknown): CarrierVerdict => (VERDICTS.includes(x as CarrierVerdict) ? (x as CarrierVerdict) : "UNKNOWN");

/** Bulk check: numbers pasted in. Unknown numbers are added to the pool first. */
export async function bulkCheck(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const raw = String(formData.get("numbers") ?? "");
  const phones = [...new Set(raw.split(/[\s,;]+/).map(normalizePhone).filter((p): p is string => Boolean(p)))];
  if (phones.length === 0) return;
  await prisma.callerIdNumber.createMany({
    data: phones.map((phone) => ({ tenantId: s.tenant.id, phone, areaCode: phone.slice(0, 3), state: stateForAreaCode(phone.slice(0, 3)) })),
    skipDuplicates: true,
  });
  const rows = await prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id, phone: { in: phones } }, select: { id: true } });
  await scanNumbers(
    s.tenant.id,
    rows.map((r) => r.id),
  );
  revalidatePath("/dids");
}

export async function testNumber(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  await scanNumbers(s.tenant.id, [String(formData.get("id"))]);
  revalidatePath("/dids");
}

/** Take a number out of rotation and let the pool pick another. */
export async function rotateNumber(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  await prisma.callerIdNumber.updateMany({ where: { id, tenantId: s.tenant.id }, data: { status: "RESTING" } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "did.rotate", target: id } });
  revalidatePath("/dids");
}

/** A human verified the carriers' view (or fixed it with the carrier): record it. */
export async function resolveNumber(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const row = await prisma.callerIdNumber.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!row) return;
  await recordReading(id, `manual:${s.user.email}`, {
    att: v(formData.get("att")),
    verizon: v(formData.get("verizon")),
    tmobile: v(formData.get("tmobile")),
    attestation: String(formData.get("attestation") ?? "").trim().toUpperCase().slice(0, 1) || null,
  });
  const back = formData.get("backInRotation") === "on";
  if (back) await prisma.callerIdNumber.update({ where: { id }, data: { status: "ACTIVE" } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "did.resolve", target: id, after: { back } } });
  revalidatePath("/dids");
}

export async function setAutoRecheck(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const on = formData.get("on") === "true";
  const settings = (s.tenant.settings ?? {}) as Record<string, unknown>;
  await prisma.tenant.update({ where: { id: s.tenant.id }, data: { settings: { ...settings, didDailyRecheck: on } } });
  revalidatePath("/dids");
}

export async function assignNumberCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  if (campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
    if (!c) return;
  }
  await prisma.callerIdNumber.updateMany({ where: { id, tenantId: s.tenant.id }, data: { campaignId } });
  revalidatePath("/dids");
}
