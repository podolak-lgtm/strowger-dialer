// An inbound text arrived at one of our numbers. Attribute it to a tenant by
// the number, to a lead by the sender, honour STOP/HELP/START, and tell the
// owning agent.
import { prisma } from "@strowger/db";
import { renderTemplate } from "@strowger/shared/cadence";
import { normalizePhone } from "@strowger/shared/phone";
import { DEFAULT_HELP_REPLY, DEFAULT_STOP_REPLY, smsKeyword } from "@strowger/shared/sms";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";
import { sendSms } from "./provider";

export interface InboundText {
  provider: string;
  providerMessageId: string | null;
  from: string; // any format
  to: string; // any format
  body: string;
  raw?: unknown;
}

export async function handleInboundText(t: InboundText): Promise<{ ok: boolean; reason?: string }> {
  const from = normalizePhone(t.from);
  const to = normalizePhone(t.to);
  if (!from || !to) return { ok: false, reason: "unparseable numbers" };

  const number = await prisma.callerIdNumber.findFirst({ where: { phone: to }, include: { tenant: true } });
  if (!number) {
    log.warn({ to }, "inbound text to a number we do not own");
    return { ok: false, reason: "unknown destination number" };
  }
  const tenantId = number.tenantId;
  if (t.providerMessageId) {
    const dup = await prisma.message.findUnique({ where: { providerMessageId: t.providerMessageId } });
    if (dup) return { ok: true, reason: "duplicate" };
  }

  // The most recently touched lead with this phone in the tenant.
  const lead = await prisma.lead.findFirst({ where: { tenantId, phone: from }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }], include: { list: { select: { campaignId: true } } } });
  const campaignId = number.campaignId ?? lead?.list.campaignId ?? null;

  const msg = await prisma.message.create({
    data: { tenantId, campaignId, leadId: lead?.id ?? null, agentId: lead?.ownerId ?? null, direction: "INBOUND", fromPhone: from, toPhone: to, body: t.body, provider: t.provider, providerMessageId: t.providerMessageId, status: "RECEIVED" },
  });
  if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "TEXT_IN", data: { messageId: msg.id, preview: t.body.slice(0, 120) } } });

  const company = number.tenant.name;
  const kw = smsKeyword(t.body);
  if (kw === "STOP") {
    await prisma.dncEntry.createMany({ data: [{ tenantId, phone: from, scope: "SYSTEM", source: "STOP_KEYWORD", note: `Texted "${t.body.slice(0, 40)}"` }], skipDuplicates: true });
    await prisma.lead.updateMany({ where: { tenantId, phone: from, status: { notIn: ["DNC", "BLOCKED"] } }, data: { status: "DNC", scrubStatus: "DNC", scrubReason: "Texted STOP", scrubbedAt: new Date(), nextDialAt: null, ownerId: null } });
    await prisma.callback.updateMany({ where: { lead: { tenantId, phone: from }, status: { in: ["SCHEDULED", "OFFERED"] } }, data: { status: "CANCELLED" } });
    if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "DNC", data: { source: "STOP_KEYWORD" } } });
    // The one message carriers require after an opt-out.
    await sendSms({ tenantId, campaignId, leadId: lead?.id ?? null, from: to, to: from, body: renderTemplate(DEFAULT_STOP_REPLY, { company }), purpose: "stop_confirm" });
  } else if (kw === "HELP") {
    await sendSms({ tenantId, campaignId, leadId: lead?.id ?? null, from: to, to: from, body: renderTemplate(DEFAULT_HELP_REPLY, { company }), purpose: "help_reply" });
  } else if (kw === "START") {
    await prisma.dncEntry.deleteMany({ where: { tenantId, phone: from, source: "STOP_KEYWORD" } });
    if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "NOTE", data: { note: "Texted START: opt-out lifted" } } });
  }

  const payload = { messageId: msg.id, leadId: lead?.id ?? null, from, to, body: t.body, keyword: kw, at: msg.createdAt.toISOString() };
  if (lead?.ownerId) emitToAgent(lead.ownerId, "text:in", payload);
  emitToTenant(tenantId, "floor:text", payload);
  return { ok: true };
}
