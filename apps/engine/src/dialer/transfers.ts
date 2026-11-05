// External transfers (owner, 5 Nov): a live lead is handed to one of the
// campaign's TransferDestinations, cold (agent dropped on answer) or warm
// (three-way until the agent leaves). The customer is never put on hold.
//
// Rooms. The lead sits in the agent's room (`agent-<userId>`). The destination
// is dialled over REST, hears the whisper, then:
//   COLD  joins a fresh room `xfer-<transferId>`; on its join the lead leg is
//         redirected into the same room. The agent's room is empty again and
//         the agent is free for the next call.
//   WARM  joins the agent's room (three-way). "Leave" redirects the lead and
//         the destination into `xfer-<transferId>`; "Cancel" hangs the
//         destination up and the lead stays with the agent.
// In `xfer-<id>` both legs carry endConferenceOnExit, so whichever side hangs
// up ends the other; the destination leg's timeLimit is the 90-minute cap.
import { prisma, type Call, type Transfer, type TransferDestination, type TransferKind } from "@strowger/db";
import { toE164 } from "@strowger/shared/phone";
import { chooseTransferCallerId, destinationE164, renderWhisper, TRANSFER_CAP_MINUTES, TRANSFER_DISPOSITION, TRANSFER_RING_SECONDS, unansweredOutcome } from "@strowger/shared/transfers";
import { getAgent } from "../agents/state";
import { chargeCallMinutes, outboundAllowed } from "../billing";
import { config } from "../config";
import { agentRoom, hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { dispositionCall } from "./calls";

type Verb = Record<string, unknown>;
type Result = { ok: true; transferId: string } | { ok: false; error: string };
type LiveTransfer = Transfer & { destination: TransferDestination | null; call: Call };

export const transferRoom = (transferId: string) => `xfer-${transferId}`;
const sidKey = (sid: string) => `xfersid:${sid}`;
const cancelKey = (transferId: string) => `xfer:cancel:${transferId}`;

/** The destination leg's call_sid → transfer id, for hooks without customerData. */
export async function transferIdForSid(sid: string): Promise<string | null> {
  return redis.get(sidKey(sid));
}

/** The external transfer in flight on a call (started, not ended), if any. */
export async function liveTransfer(callId: string): Promise<LiveTransfer | null> {
  return prisma.transfer.findFirst({ where: { callId, destinationId: { not: null }, endedAt: null }, include: { destination: true, call: true }, orderBy: { createdAt: "desc" } });
}

export type TransferState = "ringing" | "answered" | "no_answer" | "cancelled" | "failed" | "left" | "ended";

/** What the console and the floor see. */
export function transferView(t: Transfer & { destination: TransferDestination | null }, state: TransferState, extra: Record<string, unknown> = {}) {
  return { id: t.id, state, destinationName: t.destination?.name ?? "", destinationId: t.destinationId, mode: t.kind, callerIdShown: t.callerIdShown, callerIdFallback: t.callerIdFallback, answeredAt: t.answeredAt?.toISOString() ?? null, agentLeftAt: t.agentLeftAt?.toISOString() ?? null, ...extra };
}

function emitTransfer(call: { id: string; agentId: string | null; tenantId: string }, t: Transfer & { destination: TransferDestination | null }, state: TransferState, extra: Record<string, unknown> = {}): void {
  const transfer = transferView(t, state, extra);
  if (call.agentId) emitToAgent(call.agentId, "call:update", { callId: call.id, status: "transfer", transfer });
  emitToTenant(call.tenantId, "floor:call", { callId: call.id, status: `transfer_${state}`, agentId: call.agentId, transfer });
}

/** The campaign's "Transferred" disposition (XFER, a contact), created when missing. */
export async function transferredDisposition(campaignId: string, tenantId: string) {
  return prisma.disposition.upsert({
    where: { campaignId_code: { campaignId, code: TRANSFER_DISPOSITION.code } },
    update: { active: true },
    create: { tenantId, campaignId, code: TRANSFER_DISPOSITION.code, label: TRANSFER_DISPOSITION.label, isContact: true, sortOrder: 998 },
  });
}

/** Place (or re-place) the destination leg of a transfer. Returns the jambonz call_sid. */
async function placeDestinationLeg(t: Transfer, leg: Call, from: string, to: string): Promise<string> {
  type CreateReq = Parameters<typeof jambonz.calls.create>[0];
  const req = {
    from: toE164(from),
    to: { type: "phone", number: to },
    ...(config.JAMBONZ_CARRIER ? { trunk: config.JAMBONZ_CARRIER } : {}),
    ...(config.JAMBONZ_APPLICATION_SID
      ? { application_sid: config.JAMBONZ_APPLICATION_SID }
      : { call_hook: { url: hookUrl("/jambonz/call"), method: "post" as const }, call_status_hook: { url: hookUrl("/jambonz/status"), method: "post" as const } }),
    timeout: TRANSFER_RING_SECONDS,
    // The cap after the agent leaves. Both legs end together: the room ends when either leaves.
    timeLimit: TRANSFER_CAP_MINUTES * 60,
    tag: { kind: "transfer", transferId: t.id, callId: leg.id, parentCallId: t.callId, tenantId: t.tenantId },
  } as CreateReq;
  const sid = await jambonz.calls.create(req);
  await redis.set(sidKey(sid), t.id, "EX", 6 * 3600);
  await prisma.call.update({ where: { id: leg.id }, data: { providerCallId: sid, callerId: from } });
  return sid;
}

/**
 * Start a transfer: pick the caller ID, write the Transfer and the destination
 * leg's Call, dial. Telnyx refusing the `from` at create time falls back to the
 * campaign's caller ID once (a refusal that arrives later as a 403 on the
 * status hook is handled in `transferLegStatus`).
 */
export async function startExternalTransfer(callId: string, agentId: string, destinationId: string, mode: TransferKind): Promise<Result> {
  if (!jambonzConfigured) return { ok: false, error: "Telephony is not configured (jambonz API key missing)" };
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true, lead: true } });
  if (!call || call.agentId !== agentId) return { ok: false, error: "Not your call" };
  if (!call.providerCallId || call.endedAt) return { ok: false, error: "Call is not live" };
  if (!call.answeredAt) return { ok: false, error: "Wait for the lead to answer" };
  if (!call.campaign) return { ok: false, error: "This call has no campaign, so no transfer destinations" };
  const dest = await prisma.transferDestination.findFirst({ where: { id: destinationId, tenantId: call.tenantId, campaignId: call.campaign.id, active: true } });
  if (!dest) return { ok: false, error: "That destination is not on this campaign" };
  const to = destinationE164(dest.phone);
  if (!to) return { ok: false, error: `${dest.name} has no dialable number` };
  if (await liveTransfer(callId)) return { ok: false, error: "A transfer is already in progress on this call" };
  const allowed = await outboundAllowed(call.tenantId);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  const agent = await getAgent(agentId);
  if (!agent?.agentCallSid) return { ok: false, error: "Your line is not up" };

  const owned = dest.callerIdMode === "STATIC" ? (await prisma.callerIdNumber.findMany({ where: { tenantId: call.tenantId, status: "ACTIVE" }, select: { phone: true } })).map((n) => n.phone) : [];
  const choice = chooseTransferCallerId({ mode: dest.callerIdMode, leadPhone: call.phone, staticCallerId: dest.staticCallerId, ownedNumbers: owned, campaignCallerId: call.callerId });
  if (!choice) return { ok: false, error: "No caller ID is available for this transfer" };
  if (choice.source === "fallback") log.warn({ callId, destinationId, mode: dest.callerIdMode }, "transfer caller ID: using the campaign's number (customer/static number unavailable)");

  const [tenant, agentUser] = await Promise.all([prisma.tenant.findUnique({ where: { id: call.tenantId }, select: { name: true } }), prisma.user.findUnique({ where: { id: agentId }, select: { firstName: true } })]);
  const whisper = dest.whisperOn ? renderWhisper(dest.whisperText, { company: tenant?.name ?? "", campaign: call.campaign.name, destination: dest.name, agent: agentUser?.firstName ?? null, lead: call.lead }) : null;

  const transfer = await prisma.transfer.create({ data: { tenantId: call.tenantId, callId, fromAgentId: agentId, kind: mode, destinationId: dest.id, callerIdShown: choice.phone, callerIdFallback: choice.source === "fallback" } });
  const leg = await prisma.call.create({
    data: {
      tenantId: call.tenantId,
      campaignId: call.campaign.id,
      leadId: call.leadId,
      direction: "TRANSFER",
      phone: to.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1"),
      callerId: choice.phone,
      parentCallId: call.id,
      destinationId: dest.id,
      providerData: { transferId: transfer.id, whisper, mode },
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { destinationCallId: leg.id } });

  let from = choice.phone;
  let fallback = choice.source === "fallback";
  try {
    try {
      await placeDestinationLeg(transfer, leg, from, to);
    } catch (e) {
      if (fallback || !call.callerId || call.callerId === from) throw e;
      log.warn({ err: e, transferId: transfer.id, from }, "transfer leg refused at create; falling back to the campaign's caller ID");
      from = call.callerId;
      fallback = true;
      await placeDestinationLeg(transfer, leg, from, to);
    }
  } catch (e) {
    log.error({ err: e, transferId: transfer.id }, "transfer leg create failed");
    const now = new Date();
    await prisma.transfer.update({ where: { id: transfer.id }, data: { outcome: "FAILED", endedAt: now, callerIdShown: from, callerIdFallback: fallback } });
    await prisma.call.update({ where: { id: leg.id }, data: { outcome: "FAILED", endedAt: now, providerData: { ...(leg.providerData as object), error: String(e) } } });
    return { ok: false, error: `Could not dial ${dest.name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const t = await prisma.transfer.update({ where: { id: transfer.id }, data: { callerIdShown: from, callerIdFallback: fallback }, include: { destination: true } });
  if (call.leadId) {
    await prisma.leadEvent.create({ data: { tenantId: call.tenantId, leadId: call.leadId, kind: "TRANSFER_STARTED", actorId: agentId, data: { transferId: t.id, callId, destinationId: dest.id, destination: dest.name, mode, callerId: from, callerIdFallback: fallback } } });
  }
  emitTransfer(call, t, "ringing");
  return { ok: true, transferId: t.id };
}

/** The destination answered (call hook): whisper to it alone, then the room for its mode. */
export async function transferLegVerbs(transferId: string): Promise<Verb[]> {
  const t = await prisma.transfer.findUnique({ where: { id: transferId }, include: { destination: true, call: true } });
  if (!t || t.endedAt || !t.destination) return [{ verb: "hangup" }];
  if (!t.call.providerCallId || t.call.endedAt || (await redis.get(cancelKey(t.id)))) return [{ verb: "hangup" }];
  const leg = t.destinationCallId ? await prisma.call.findUnique({ where: { id: t.destinationCallId } }) : null;
  const whisper = (leg?.providerData as { whisper?: string | null } | null)?.whisper ?? null;
  const verbs: Verb[] = [];
  // Only the destination hears this: it is on its own leg, not yet in any room.
  if (whisper) verbs.push({ verb: "say", text: whisper });
  // jambonz skips a `say` silently when the account has no text-to-speech vendor (5 Nov: "she did not hear the whisper").
  log.info({ transferId: t.id, mode: t.kind, whisper: whisper ?? null, whisperOn: t.destination.whisperOn }, "transfer leg answered: whisper then join");
  if (t.kind === "COLD") {
    verbs.push({
      verb: "conference",
      name: transferRoom(t.id),
      memberTag: "destination",
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { transferId: t.id, leg: "destination", tenantId: t.tenantId }),
      statusEvents: ["start", "end", "join", "leave"],
    });
  } else {
    verbs.push({
      verb: "conference",
      name: agentRoom(t.fromAgentId),
      memberTag: "destination",
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { transferId: t.id, leg: "destination", tenantId: t.tenantId }),
      statusEvents: ["join", "leave"],
    });
  }
  verbs.push({ verb: "hangup" });
  return verbs;
}

/** A leg redirected into the transfer's own room after the agent has left. */
export async function transferJoinVerbs(transferId: string, leg: "lead" | "destination"): Promise<Verb[]> {
  const t = await prisma.transfer.findUnique({ where: { id: transferId } });
  // The far side is already gone: nobody to join, so the lead must not sit in an empty room.
  if (!t || t.endedAt) return [{ verb: "hangup" }];
  return [
    {
      verb: "conference",
      name: transferRoom(t.id),
      memberTag: leg,
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { transferId: t.id, leg, tenantId: t.tenantId, ...(leg === "lead" ? { callId: t.callId } : {}) }),
      statusEvents: ["start", "end", "join", "leave"],
    },
    { verb: "hangup" },
  ];
}

/** Conference events on a transfer's legs. A cold destination joining its room is the moment the agent is dropped. */
export async function transferConfEvent(q: { transferId: string; leg?: string }, b: { event?: string }): Promise<void> {
  if (q.leg !== "destination" || b.event !== "join") return;
  const t = await prisma.transfer.findUnique({ where: { id: q.transferId } });
  if (!t || t.endedAt || t.kind !== "COLD" || t.agentLeftAt) return;
  const r = await agentLeaveTransfer(t.callId, t.fromAgentId, "auto");
  if (!r.ok) log.warn({ transferId: t.id, error: r.error }, "cold transfer: could not drop the agent");
}

/** Status lifecycle of the destination leg. */
export async function transferLegStatus(transferId: string, sid: string, status: string, sipStatus: number | undefined, duration: number | undefined): Promise<void> {
  const t = await prisma.transfer.findUnique({ where: { id: transferId }, include: { destination: true, call: true } });
  if (!t) return;
  const leg = t.destinationCallId ? await prisma.call.findUnique({ where: { id: t.destinationCallId } }) : null;
  // An empty sid is a forced finish from our side (cancel / lead gone); otherwise ignore a replaced leg (caller-ID fallback redial).
  if (sid && leg?.providerCallId && leg.providerCallId !== sid) return;
  const now = new Date();

  if (status === "ringing" || status === "early-media") {
    if (leg && !leg.ringingAt) await prisma.call.update({ where: { id: leg.id }, data: { ringingAt: now } });
    return;
  }
  if (status === "in-progress") {
    if (t.answeredAt) return;
    const updated = await prisma.transfer.update({ where: { id: t.id }, data: { answeredAt: now }, include: { destination: true } });
    if (leg) await prisma.call.update({ where: { id: leg.id }, data: { answeredAt: now, bridgedAt: now } });
    if (t.call.leadId) await prisma.leadEvent.create({ data: { tenantId: t.tenantId, leadId: t.call.leadId, kind: "TRANSFER_ANSWERED", actorId: t.fromAgentId, data: { transferId: t.id, destination: t.destination?.name ?? null, mode: t.kind } } });
    emitTransfer(t.call, updated, "answered");
    return;
  }
  if (!["completed", "failed", "busy", "no-answer"].includes(status)) return;
  if (t.endedAt) return;

  const cancelled = Boolean(await redis.get(cancelKey(t.id)));
  // Telnyx refused the lead's number as the caller ID (403 on the INVITE): once, redial from the campaign's number.
  if (!t.answeredAt && !cancelled && status === "failed" && sipStatus && [401, 403, 407].includes(sipStatus) && !t.callerIdFallback && t.call.callerId && t.call.callerId !== t.callerIdShown && leg && !t.call.endedAt) {
    log.warn({ transferId: t.id, sipStatus, from: t.callerIdShown }, "transfer leg refused by the carrier; redialling from the campaign's caller ID");
    try {
      await redis.del(sidKey(sid));
      await placeDestinationLeg(t, leg, t.call.callerId, destinationE164(t.destination?.phone ?? "") ?? "");
      const updated = await prisma.transfer.update({ where: { id: t.id }, data: { callerIdShown: t.call.callerId, callerIdFallback: true }, include: { destination: true } });
      await prisma.call.update({ where: { id: leg.id }, data: { providerData: { ...(leg.providerData as object), refusedFrom: t.callerIdShown, sipStatus } } });
      emitTransfer(t.call, updated, "ringing");
      return;
    } catch (e) {
      log.error({ err: e, transferId: t.id }, "transfer redial failed");
    }
  }

  const outcome = t.answeredAt ? "ANSWERED" : unansweredOutcome(status, cancelled);
  const updated = await prisma.transfer.update({ where: { id: t.id }, data: { endedAt: now, outcome, completedAt: t.answeredAt ? now : null }, include: { destination: true } });
  if (leg && !leg.endedAt) {
    const legOutcome = t.answeredAt ? "BRIDGED" : outcome === "CANCELLED" ? "CANCELLED" : status === "busy" ? "BUSY" : status === "failed" ? "FAILED" : "NO_ANSWER";
    await prisma.call.update({ where: { id: leg.id }, data: { endedAt: now, outcome: legOutcome, providerData: { ...(leg.providerData as object), finalStatus: status, sipStatus: sipStatus ?? null, duration: duration ?? null } } });
    void chargeCallMinutes(leg.id).catch((e) => log.warn({ err: e, callId: leg.id }, "billing: transfer minutes charge failed"));
  }
  await redis.del(sidKey(sid), cancelKey(t.id));
  if (!t.answeredAt) {
    if (t.call.leadId) await prisma.leadEvent.create({ data: { tenantId: t.tenantId, leadId: t.call.leadId, kind: outcome === "CANCELLED" ? "TRANSFER_CANCELLED" : "TRANSFER_NO_ANSWER", actorId: t.fromAgentId, data: { transferId: t.id, destination: t.destination?.name ?? null, mode: t.kind, status, sipStatus: sipStatus ?? null } } });
    emitTransfer(t.call, updated, outcome === "CANCELLED" ? "cancelled" : outcome === "FAILED" ? "failed" : "no_answer");
  } else {
    // Answered and now over. With the agent gone the room ended and the lead leg hangs up by itself;
    // with the agent still there (warm, destination hung up, or Cancel) the lead stays with the agent.
    emitTransfer(t.call, updated, "ended");
  }
}

/** Cancel: drop the destination leg (ringing, or in the warm three-way); the lead stays with the agent. */
export async function cancelTransfer(callId: string, agentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await liveTransfer(callId);
  if (!t) return { ok: false, error: "No transfer is in progress" };
  if (t.call.agentId !== agentId) return { ok: false, error: "Not your call" };
  if (t.agentLeftAt) return { ok: false, error: "You have already left this call" };
  await redis.set(cancelKey(t.id), "1", "EX", 600);
  const leg = t.destinationCallId ? await prisma.call.findUnique({ where: { id: t.destinationCallId } }) : null;
  if (leg?.providerCallId) {
    await jambonz.calls.update(leg.providerCallId, { call_status: t.answeredAt ? "completed" : "no-answer" }).catch((e) => log.warn({ err: e, transferId: t.id }, "transfer cancel hangup failed"));
    // The status hook writes the outcome.
    return { ok: true };
  }
  await transferLegStatus(t.id, "", "completed", undefined, undefined);
  return { ok: true };
}

/**
 * The agent leaves: lead and destination move to the transfer's own room, the
 * call is auto-dispositioned "Transferred" and the agent lands in wrap-up (free
 * to change it, then Ready). `how` = "auto" for cold on answer, "leave" for the
 * warm button.
 */
export async function agentLeaveTransfer(callId: string, agentId: string, how: "auto" | "leave"): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await liveTransfer(callId);
  if (!t) return { ok: false, error: "No transfer is in progress" };
  if (t.call.agentId !== agentId) return { ok: false, error: "Not your call" };
  if (t.agentLeftAt) return { ok: true };
  const now = new Date();
  if (!t.answeredAt) {
    // A cold destination joining its room proves it answered, even if its in-progress status is still on the way.
    if (how !== "auto") return { ok: false, error: `${t.destination?.name ?? "The destination"} has not answered yet. Wait, or cancel the transfer.` };
    await prisma.transfer.update({ where: { id: t.id }, data: { answeredAt: now } });
    if (t.destinationCallId) await prisma.call.updateMany({ where: { id: t.destinationCallId, answeredAt: null }, data: { answeredAt: now, bridgedAt: now } });
  }
  if (!t.call.providerCallId || t.call.endedAt) return { ok: false, error: "The lead is no longer on the line" };
  const claimed = await prisma.transfer.updateMany({ where: { id: t.id, agentLeftAt: null }, data: { agentLeftAt: now } });
  if (claimed.count !== 1) return { ok: true };
  const name = t.destination?.name ?? "destination";
  const mode = t.kind.toLowerCase();

  // Move the legs. Cold: the destination already started the room; warm: both move.
  if (t.kind === "WARM" && t.destinationCallId) {
    const leg = await prisma.call.findUnique({ where: { id: t.destinationCallId } });
    if (leg?.providerCallId) await jambonz.calls.redirect(leg.providerCallId, { url: hookUrl("/jambonz/xfer-join", { transferId: t.id, leg: "destination" }), method: "POST" }).catch((e) => log.warn({ err: e, transferId: t.id }, "destination redirect failed"));
  }
  try {
    await jambonz.calls.redirect(t.call.providerCallId, { url: hookUrl("/jambonz/xfer-join", { transferId: t.id, leg: "lead" }), method: "POST" });
  } catch (e) {
    log.error({ err: e, transferId: t.id }, "lead redirect into the transfer room failed");
  }

  if (t.call.leadId) await prisma.leadEvent.create({ data: { tenantId: t.tenantId, leadId: t.call.leadId, kind: "AGENT_LEFT", actorId: agentId, data: { transferId: t.id, destination: name, mode, how } } });
  const disp = await transferredDisposition(t.call.campaignId ?? "", t.tenantId).catch(() => null);
  if (disp) {
    await dispositionCall({ callId, dispositionId: disp.id, actorId: agentId, notes: `Transferred to ${name} (${mode})`, keepWrapUp: true }).catch((e) => log.warn({ err: e, callId }, "transfer auto-disposition failed"));
  }
  const fresh = await prisma.transfer.findUnique({ where: { id: t.id }, include: { destination: true } });
  if (fresh) emitTransfer(t.call, fresh, "left", { dispositionId: disp?.id ?? null, dispositionLabel: disp?.label ?? null, how });
  return { ok: true };
}

/** The lead leg ended while a transfer was still in flight: drop the destination leg too. */
export async function endLiveTransfersForCall(callId: string): Promise<void> {
  const live = await prisma.transfer.findMany({ where: { callId, destinationId: { not: null }, endedAt: null } });
  for (const t of live) {
    if (!t.answeredAt) await redis.set(cancelKey(t.id), "1", "EX", 600);
    const leg = t.destinationCallId ? await prisma.call.findUnique({ where: { id: t.destinationCallId } }) : null;
    if (leg?.providerCallId && !leg.endedAt) {
      await jambonz.calls.update(leg.providerCallId, { call_status: t.answeredAt ? "completed" : "no-answer" }).catch((e) => log.warn({ err: e, transferId: t.id }, "transfer leg hangup after lead ended failed"));
    } else {
      await transferLegStatus(t.id, "", "completed", undefined, undefined);
    }
  }
}

/** Live transferred calls for the floor: the agent has left, the lead and destination are still talking. */
export async function transferredCalls(tenantId: string) {
  const rows = await prisma.transfer.findMany({
    where: { tenantId, destinationId: { not: null }, agentLeftAt: { not: null }, endedAt: null, call: { endedAt: null } },
    include: { destination: { select: { name: true } }, call: { select: { id: true, campaignId: true, lead: { select: { firstName: true, lastName: true, phone: true } } } }, fromAgent: { select: { firstName: true, lastName: true, email: true } } },
    orderBy: { agentLeftAt: "desc" },
  });
  return rows.map((t) => ({
    transferId: t.id,
    callId: t.call.id,
    campaignId: t.call.campaignId,
    destinationName: t.destination?.name ?? "",
    mode: t.kind,
    leadName: t.call.lead ? [t.call.lead.firstName, t.call.lead.lastName].filter(Boolean).join(" ") || null : null,
    leadPhone: t.call.lead?.phone ?? null,
    agentName: t.fromAgent.firstName ? `${t.fromAgent.firstName} ${t.fromAgent.lastName ?? ""}`.trim() : t.fromAgent.email,
    agentId: t.fromAgentId,
    since: (t.agentLeftAt ?? t.createdAt).getTime(),
  }));
}
