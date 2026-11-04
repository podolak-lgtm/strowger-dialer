"use server";

import { prisma } from "@strowger/db";
import { instantAtLocal } from "@strowger/shared/cadence";
import { redirect } from "next/navigation";

export async function bookCallback(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const when = String(formData.get("when") ?? "");
  const lead = await prisma.lead.findUnique({ where: { callbackToken: token }, include: { list: { select: { campaignId: true } } } });
  if (!lead || !lead.list.campaignId) redirect("/");
  const zone = lead.timezone ?? "America/New_York";
  const now = new Date();

  let dueAt: Date;
  if (when === "15m") dueAt = new Date(now.getTime() + 15 * 60_000);
  else if (when === "30m") dueAt = new Date(now.getTime() + 30 * 60_000);
  else if (when === "tomorrow14") dueAt = instantAtLocal(zone, now, 14, 1);
  else {
    const custom = String(formData.get("custom") ?? "");
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(custom);
    if (!m) redirect(`/cb/${token}`);
    // Interpret the picked wall-clock time in the lead's zone.
    const picked = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
    dueAt = instantAtLocal(zone, picked, Number(m[4]) + Number(m[5]) / 60, 0);
    if (dueAt.getTime() < now.getTime() + 5 * 60_000) redirect(`/cb/${token}`);
  }

  await prisma.$transaction(async (tx) => {
    // One live self-booked callback per lead: replace any earlier one.
    await tx.callback.updateMany({ where: { leadId: lead.id, status: "SCHEDULED", agentId: null }, data: { status: "CANCELLED" } });
    await tx.callback.create({
      data: { tenantId: lead.tenantId, campaignId: lead.list.campaignId!, leadId: lead.id, agentId: lead.ownerId ?? null, scope: lead.ownerId ? "AGENT" : "CAMPAIGN", dueAt, note: "Self-booked from missed-call text" },
    });
    await tx.lead.update({ where: { id: lead.id }, data: { status: "CALLBACK", nextDialAt: dueAt, redialsCancelledOn: now } });
    await tx.leadEvent.create({ data: { tenantId: lead.tenantId, leadId: lead.id, kind: "CALLBACK_SET", data: { dueAt, source: "self_service", choice: when } } });
  });
  redirect(`/cb/${token}?done=1`);
}
