"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

/** Mark numbers as registered at the Free Caller Registry (required before the first dial). */
export async function markRegistered(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const ids = formData.getAll("ids").map(String);
  const on = formData.get("registered") !== "false";
  await prisma.callerIdNumber.updateMany({ where: { id: { in: ids }, tenantId: s.tenant.id }, data: { registeredAt: on ? new Date() : null } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: on ? "did.registered" : "did.unregistered", after: { count: ids.length } } });
  revalidatePath("/dids");
}

export async function setDailyCap(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const raw = String(formData.get("dailyCap") ?? "").trim();
  const dailyCap = raw === "" ? null : Math.max(1, Math.min(500, Number(raw) || 75));
  await prisma.callerIdNumber.updateMany({ where: { id, tenantId: s.tenant.id }, data: { dailyCap } });
  revalidatePath("/dids");
}

/** Put a number back in rotation after a rest, or extend the rest. */
export async function setRest(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const days = Number(formData.get("days"));
  await prisma.callerIdNumber.updateMany({
    where: { id, tenantId: s.tenant.id },
    data: days > 0 ? { status: "RESTING", restUntil: new Date(Date.now() + days * 86_400_000) } : { status: "ACTIVE", restUntil: null },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: days > 0 ? "did.rest" : "did.restore", target: id, after: { days } } });
  revalidatePath("/dids");
}

/** Drive the Free Caller Registry form from the engine (several minutes). */
export async function registerAtRegistry() {
  const s = await requireRole("SUPERVISOR");
  let msg: string;
  let kind = "ok";
  try {
    const r = await engine<{ ok: boolean; feedbackId?: string; count: number; error?: string; step?: string }>("/provision/fcr", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) });
    if (r.ok) {
      msg = `Registered ${r.count} number${r.count === 1 ? "" : "s"} at the Free Caller Registry (feedback id ${r.feedbackId}). First Orion, Hiya and TNS email confirmations to the contact address.`;
      await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "did.registered", after: { count: r.count, feedbackId: r.feedbackId, via: "fcr-auto" } } });
    } else {
      kind = "error";
      msg = `Registry run stopped at "${r.step}": ${r.error}`;
    }
  } catch (e) {
    kind = "error";
    msg = e instanceof Error ? e.message : String(e);
  }
  revalidatePath("/dids");
  redirect(`/dids?msg=${encodeURIComponent(msg)}&kind=${kind}`);
}
