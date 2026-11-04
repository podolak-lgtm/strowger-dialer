"use server";

import { prisma, type CadenceKind } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

function num(fd: FormData, k: string, fallback: number, min: number, max: number): number {
  const v = Number(fd.get(k));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function hours(fd: FormData, k: string, fallback: [number, number]): [number, number] {
  const a = Number(fd.get(`${k}Start`));
  const b = Number(fd.get(`${k}End`));
  return Number.isFinite(a) && Number.isFinite(b) && a < b && a >= 0 && b <= 24 ? [a, b] : fallback;
}

export async function saveCadence(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const kind = (String(formData.get("kind")) === "FRESH" ? "FRESH" : "AGED") as CadenceKind;
  const data = {
    tenantId: s.tenant.id,
    name,
    kind,
    instantDial: kind === "FRESH" && formData.get("instantDial") === "on",
    instantDelaySeconds: num(formData, "instantDelaySeconds", 5, 0, 10),
    preCallSms: String(formData.get("preCallSms") ?? "").trim() || null,
    missedCallSms: String(formData.get("missedCallSms") ?? "").trim() || null,
    maxAttemptsPerDay: num(formData, "maxAttemptsPerDay", kind === "FRESH" ? 3 : 2, 1, 10),
    minGapMinutes: num(formData, "minGapMinutes", 240, 5, 24 * 60),
    rotateDayparts: formData.get("rotateDayparts") === "on",
    dayparts: { MORNING: hours(formData, "morning", [8.5, 11.5]), AFTERNOON: hours(formData, "afternoon", [12.5, 16.5]), EVENING: hours(formData, "evening", [17, 19.5]) },
    cancelRedialsOnAnswer: formData.get("cancelRedialsOnAnswer") === "on",
  };
  if (id) {
    const own = await prisma.cadenceProfile.findFirst({ where: { id, tenantId: s.tenant.id } });
    if (!own) throw new Error("Unknown cadence");
    await prisma.cadenceProfile.update({ where: { id }, data });
    revalidatePath(`/cadences/${id}`);
    revalidatePath("/cadences");
  } else {
    const c = await prisma.cadenceProfile.create({ data });
    redirect(`/cadences/${c.id}`);
  }
}

export async function deleteCadence(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  await prisma.list.updateMany({ where: { cadenceProfileId: id, tenantId: s.tenant.id }, data: { cadenceProfileId: null } });
  await prisma.cadenceProfile.deleteMany({ where: { id, tenantId: s.tenant.id } });
  redirect("/cadences");
}

/** Seed the two cadences from the owner's spec for a tenant that has none. */
export async function seedStandardCadences() {
  const s = await requireRole("SUPERVISOR");
  const count = await prisma.cadenceProfile.count({ where: { tenantId: s.tenant.id } });
  if (count === 0) {
    await prisma.cadenceProfile.createMany({
      data: [
        {
          tenantId: s.tenant.id,
          name: "Fresh inbound (real-time)",
          kind: "FRESH",
          instantDial: true,
          instantDelaySeconds: 5,
          preCallSms: "Hi {{first_name}}, thank you for your order! You are about to receive a call from us at {{caller_id_number}}. Please answer when we call!",
          missedCallSms: "Hey {{first_name}}, sorry I missed you! Call us back anytime, or tap the link to pick a quick callback time: {{quick_callback_link}}",
          maxAttemptsPerDay: 3,
          minGapMinutes: 240,
          rotateDayparts: false,
          cancelRedialsOnAnswer: true,
        },
        {
          tenantId: s.tenant.id,
          name: "Aged re-engagement",
          kind: "AGED",
          instantDial: false,
          preCallSms: null,
          missedCallSms: null,
          maxAttemptsPerDay: 2,
          minGapMinutes: 240,
          rotateDayparts: true,
          cancelRedialsOnAnswer: true,
        },
      ],
    });
  }
  revalidatePath("/cadences");
}
