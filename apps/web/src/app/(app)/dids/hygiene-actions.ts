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

export type FcrProgress = { state: "running" | "done" | "failed"; step: string; log: { at: string; line: string }[]; startedAt: string; finishedAt?: string; result?: { ok: boolean; feedbackId?: string; count: number; error?: string; step?: string } };

/** Start the Free Caller Registry run on the engine; it runs in the background and the page shows its progress. */
export async function registerAtRegistry() {
  const s = await requireRole("SUPERVISOR");
  let msg: string | null = null;
  try {
    const r = await engine<{ ok: boolean; error?: string }>("/provision/fcr", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) });
    if (!r.ok) msg = r.error ?? "Could not start";
    else await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "did.register.start" } });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  revalidatePath("/dids");
  redirect(msg ? `/dids?msg=${encodeURIComponent(msg)}&kind=error` : "/dids");
}

export async function registryProgress(): Promise<FcrProgress | null> {
  const s = await requireRole("SUPERVISOR");
  try {
    const r = await engine<{ progress: FcrProgress | null }>(`/provision/fcr/status?tenantId=${s.tenant.id}`);
    return r.progress;
  } catch {
    return null;
  }
}
