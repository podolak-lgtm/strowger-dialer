"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

/** Supervisors flag a lead VIP: it jumps inbound queues by the queue's VIP points. */
export async function setVip(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id") ?? "");
  const vip = formData.get("vip") === "1";
  const lead = await prisma.lead.findFirst({ where: { id, tenantId: s.tenant.id }, select: { id: true, vip: true } });
  if (!lead || lead.vip === vip) return;
  await prisma.lead.update({ where: { id }, data: { vip } });
  await prisma.leadEvent.create({ data: { tenantId: s.tenant.id, leadId: id, kind: "NOTE", actorId: s.user.id, data: { changes: { vip: { from: lead.vip, to: vip } } } } });
  revalidatePath("/leads");
}
