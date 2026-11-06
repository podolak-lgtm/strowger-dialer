// What the AI answer may do on a call (function calling through the agent
// verb's toolHook). Each tool returns a short sentence the model reads back;
// none of them reveals more about the caller than lookup_caller's fields.
import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared/phone";
import { resolveZone } from "@strowger/shared/geo";
import { callerLocalLine, validateCallbackTime } from "@strowger/shared/inbound";
import { log } from "../../log";
import { emitToAgent, emitToTenant } from "../../realtime";
import { boxForQueue } from "../common";
import { patchAiState } from "./control";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const AI_TOOLS: ToolDef[] = [
  {
    name: "transfer_to_human",
    description: "Put the caller through to a person on the team. Use when they ask for a person, when you cannot help, or when they are upset.",
    parameters: { type: "object", properties: { reason: { type: "string", description: "Why, in a few words, for the person who takes the call." } }, required: ["reason"] },
  },
  {
    name: "lookup_caller",
    description: "What we know about the caller from the number they are calling from: their name, status, the last outcome, and any upcoming callback. Nothing else.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "book_callback",
    description: "Book a call back from the team at a time the caller chose. Confirm the day and time with the caller before booking.",
    parameters: {
      type: "object",
      properties: {
        local_time: { type: "string", description: "The time in the caller's local time zone, as YYYY-MM-DDTHH:MM (24-hour)." },
        note: { type: "string", description: "What the call back is about." },
      },
      required: ["local_time"],
    },
  },
  {
    name: "take_message",
    description: "Leave a message for the team in the caller's words, with their name and the best number to call back.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        caller_name: { type: "string" },
        callback_number: { type: "string", description: "Ten digits, if different from the number they are calling from." },
      },
      required: ["message"],
    },
  },
];

type Args = Record<string, unknown>;
const str = (a: Args, k: string, max = 500) => (typeof a[k] === "string" ? (a[k] as string).trim().slice(0, max) : "");

async function context(callId: string) {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: true, lead: { include: { list: { select: { campaignId: true } } } } } });
  if (!call) return null;
  const lead = call.lead ?? (call.phone.length === 10 ? await prisma.lead.findFirst({ where: { tenantId: call.tenantId, phone: call.phone }, orderBy: [{ lastAttemptAt: "desc" }, { postedAt: "desc" }], include: { list: { select: { campaignId: true } } } }) : null);
  const zone = lead?.timezone ?? resolveZone({ zip: lead?.zip, state: lead?.state, phone: call.phone })?.timezone ?? null;
  return { call, lead, zone };
}

export async function lookupCaller(callId: string): Promise<string> {
  const c = await context(callId);
  if (!c) return "No record.";
  const { call, lead, zone } = c;
  if (!lead) return JSON.stringify({ known: false, note: "We have no record for this number." });
  const [last, cb] = await Promise.all([
    prisma.call.findFirst({ where: { tenantId: call.tenantId, leadId: lead.id, dispositionId: { not: null } }, orderBy: { dialedAt: "desc" }, select: { disposition: { select: { label: true } }, dialedAt: true } }),
    prisma.callback.findFirst({ where: { tenantId: call.tenantId, leadId: lead.id, status: "SCHEDULED", dueAt: { gte: new Date() } }, orderBy: { dueAt: "asc" }, select: { dueAt: true } }),
  ]);
  return JSON.stringify({
    known: true,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null,
    status: lead.status.toLowerCase(),
    lastOutcome: last?.disposition?.label ?? null,
    upcomingCallback: cb ? (zone ? callerLocalLine(zone, cb.dueAt) : cb.dueAt.toISOString()) : null,
  });
}

export async function bookCallback(callId: string, args: Args): Promise<string> {
  const c = await context(callId);
  if (!c) return "Could not book: the call was not found.";
  const { call, zone } = c;
  let lead = c.lead;
  const v = validateCallbackTime(str(args, "local_time", 20), zone, new Date());
  if (!v.ok) return `Not booked: ${v.error}`;
  const campaignId = call.queue?.campaignId ?? call.campaignId ?? lead?.list.campaignId ?? null;
  if (!campaignId) return "Not booked: call backs are not available on this line. Offer to take a message instead.";
  if (!lead) {
    // A caller we have never dialled: they become a lead in the campaign's "Inbound callers" list, like manual dials.
    let list = await prisma.list.findFirst({ where: { tenantId: call.tenantId, campaignId, name: "Inbound callers" } });
    if (!list) list = await prisma.list.create({ data: { tenantId: call.tenantId, campaignId, name: "Inbound callers", source: "UPLOAD", priority: 9 } });
    const z = resolveZone({ phone: call.phone });
    const created = await prisma.lead.upsert({ where: { listId_phone: { listId: list.id, phone: call.phone } }, create: { tenantId: call.tenantId, listId: list.id, phone: call.phone, timezone: z?.timezone ?? null, state: z?.state ?? null, status: "NEW", scrubStatus: "PENDING" }, update: {} });
    lead = { ...created, list: { campaignId } };
    await prisma.call.update({ where: { id: callId }, data: { leadId: created.id } });
  }
  const agentId = lead.lastAgentId ?? lead.ownerId ?? null;
  const note = str(args, "note", 200) || "Booked by the AI answer";
  await prisma.callback.create({ data: { tenantId: call.tenantId, campaignId, leadId: lead.id, agentId, scope: agentId ? "AGENT" : "CAMPAIGN", dueAt: v.at, note: `AI answer: ${note}` } });
  await prisma.lead.update({ where: { id: lead.id }, data: { status: lead.status === "DNC" || lead.status === "BLOCKED" ? lead.status : "CALLBACK", nextDialAt: v.at } });
  await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: lead.id, kind: "CALLBACK_SET", data: { dueAt: v.at.toISOString(), source: "ai", callId, note } } });
  await patchAiState(callId, { pending: "CALLBACK" });
  log.info({ callId, leadId: lead.id, dueAt: v.at.toISOString() }, "AI booked a callback");
  return `Booked: we will call ${formatPhone(call.phone)} at ${zone ? callerLocalLine(zone, v.at) : v.at.toISOString()}. Tell the caller.`;
}

export async function takeMessage(callId: string, args: Args): Promise<string> {
  const c = await context(callId);
  const queue = c?.call.queue;
  if (!c || !queue) return "Could not take the message.";
  const { call } = c;
  const message = str(args, "message", 2000);
  if (!message) return "The message is empty: ask the caller what they would like to say.";
  const name = str(args, "caller_name", 100);
  const number = str(args, "callback_number", 20).replace(/\D/g, "").slice(-10);
  const box = await boxForQueue(queue);
  const text = [`Message taken by the AI answer${name ? ` from ${name}` : ""}:`, message, number && number !== call.phone ? `Call back on ${formatPhone(number)}.` : null].filter(Boolean).join(" ");
  const vm = await prisma.voicemail.create({ data: { tenantId: call.tenantId, boxId: box.id, callId, fromPhone: call.phone, transcript: text, assigneeId: box.ownerId } });
  await patchAiState(callId, { pending: "MESSAGE" });
  const payload = { voicemailId: vm.id, boxId: box.id, from: call.phone, durationSec: 0 };
  if (box.ownerId) emitToAgent(box.ownerId, "voicemail:new", payload);
  emitToTenant(call.tenantId, "floor:voicemail", payload);
  return `Message saved for the team (${box.name}). Tell the caller someone will get back to them.`;
}
