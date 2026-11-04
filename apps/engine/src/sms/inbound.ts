// An inbound text arrived at one of our numbers. Attribute it to a tenant by
// the number, to a lead by the sender, honour STOP/HELP/START, let the AI
// read anything else for an opt-out or a callback request, and tell the
// owning agent.
import { prisma } from "@strowger/db";
import { renderTemplate } from "@strowger/shared/cadence";
import { normalizePhone } from "@strowger/shared/phone";
import { DEFAULT_HELP_REPLY, DEFAULT_STOP_REPLY, callbackDue, smsKeyword, type ReplyAction } from "@strowger/shared/sms";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";
import { classifyReply, decide, smsAiConfigured, type Classification } from "./classify";
import { sendSms } from "./provider";

export interface InboundText {
  provider: string;
  providerMessageId: string | null;
  from: string; // any format
  to: string; // any format
  body: string;
  raw?: unknown;
}

interface OptOutCtx {
  tenantId: string;
  campaignId: string | null;
  leadId: string | null;
  phone: string;
  ourNumber: string;
  company: string;
}

/** Everything an opt-out means: system DNC, every lead with the number off the hopper, callbacks cancelled, one confirmation. */
async function applyOptOut(ctx: OptOutCtx, source: "STOP_KEYWORD" | "AI_OPT_OUT", note: string) {
  await prisma.dncEntry.createMany({ data: [{ tenantId: ctx.tenantId, phone: ctx.phone, scope: "SYSTEM", source, note }], skipDuplicates: true });
  await prisma.lead.updateMany({ where: { tenantId: ctx.tenantId, phone: ctx.phone, status: { notIn: ["DNC", "BLOCKED"] } }, data: { status: "DNC", scrubStatus: "DNC", scrubReason: source === "STOP_KEYWORD" ? "Texted STOP" : "Asked us to stop by text", scrubbedAt: new Date(), nextDialAt: null, ownerId: null } });
  await prisma.callback.updateMany({ where: { lead: { tenantId: ctx.tenantId, phone: ctx.phone }, status: { in: ["SCHEDULED", "OFFERED"] } }, data: { status: "CANCELLED" } });
  if (ctx.leadId) await prisma.leadEvent.create({ data: { tenantId: ctx.tenantId, leadId: ctx.leadId, kind: "DNC", data: { source, note } } });
  // The one message carriers require after an opt-out.
  await sendSms({ tenantId: ctx.tenantId, campaignId: ctx.campaignId, leadId: ctx.leadId, from: ctx.ourNumber, to: ctx.phone, body: renderTemplate(DEFAULT_STOP_REPLY, { company: ctx.company }), purpose: "stop_confirm" });
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
  const ctx: OptOutCtx = { tenantId, campaignId, leadId: lead?.id ?? null, phone: from, ourNumber: to, company };
  const kw = smsKeyword(t.body);
  let ai: Classification | null = null;
  let action: ReplyAction = "none";

  if (kw === "STOP") {
    await applyOptOut(ctx, "STOP_KEYWORD", `Texted "${t.body.slice(0, 40)}"`);
  } else if (kw === "HELP") {
    await sendSms({ tenantId, campaignId, leadId: lead?.id ?? null, from: to, to: from, body: renderTemplate(DEFAULT_HELP_REPLY, { company }), purpose: "help_reply" });
  } else if (kw === "START") {
    await prisma.dncEntry.deleteMany({ where: { tenantId, phone: from, source: { in: ["STOP_KEYWORD", "AI_OPT_OUT"] } } });
    if (lead) await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "NOTE", data: { note: "Texted START: opt-out lifted" } } });
  } else if (smsAiConfigured) {
    // No keyword. Let the AI read it: "please don't call me" is an opt-out too.
    const thread = await prisma.message.findMany({ where: { tenantId, OR: [{ fromPhone: from }, { toPhone: from }], id: { not: msg.id } }, orderBy: { createdAt: "desc" }, take: 6, select: { direction: true, body: true } });
    ai = await classifyReply({ body: t.body, thread: thread.reverse(), timezone: lead?.timezone, leadFirstName: lead?.firstName });
    if (ai) {
      await prisma.message.update({ where: { id: msg.id }, data: { intent: ai.intent, intentConfidence: ai.confidence, intentReason: ai.reason } });
      action = decide(ai);
      if (action === "opt_out") {
        await applyOptOut(ctx, "AI_OPT_OUT", `Texted "${t.body.slice(0, 60)}" (AI ${Math.round(ai.confidence * 100)}%: ${ai.reason.slice(0, 120)})`);
      } else if (action === "review" && lead) {
        // Not sure enough to act alone: no more automatic touches until a person looks.
        await prisma.lead.update({ where: { id: lead.id }, data: { nextDialAt: null } });
        await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "NOTE", data: { note: `Possible opt-out by text (AI ${Math.round(ai.confidence * 100)}%): ${ai.reason}`, messageId: msg.id } } });
      } else if (action === "callback" && lead && campaignId) {
        const dueAt = callbackDue(ai.callback_at);
        await prisma.callback.create({ data: { tenantId, campaignId, leadId: lead.id, agentId: lead.ownerId, scope: lead.ownerId ? "AGENT" : "CAMPAIGN", dueAt, note: `Asked by text: "${t.body.slice(0, 80)}"` } });
        await prisma.lead.update({ where: { id: lead.id }, data: { status: lead.status === "DNC" || lead.status === "BLOCKED" ? lead.status : "CALLBACK", nextDialAt: dueAt } });
        await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "CALLBACK_SET", data: { dueAt: dueAt.toISOString(), source: "text", messageId: msg.id } } });
      } else if (ai.intent === "WRONG_NUMBER" && lead) {
        await prisma.leadEvent.create({ data: { tenantId, leadId: lead.id, kind: "NOTE", data: { note: `Replied that this is the wrong number: ${ai.reason}`, messageId: msg.id } } });
      }
    }
  }

  const payload = { messageId: msg.id, leadId: lead?.id ?? null, from, to, body: t.body, keyword: kw, intent: ai?.intent ?? null, confidence: ai?.confidence ?? null, action, at: msg.createdAt.toISOString() };
  if (lead?.ownerId) emitToAgent(lead.ownerId, "text:in", payload);
  emitToTenant(tenantId, "floor:text", payload);
  return { ok: true };
}
