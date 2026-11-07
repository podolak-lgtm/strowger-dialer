// Leaving a voicemail: the verbs that say or play the message, the
// personalisation variables, and the agent-triggered drop.
import { prisma, type Campaign, type Lead } from "@strowger/db";
import { prettyPhone, renderTemplate } from "@strowger/shared/cadence";
import { getAgent, patchAgent } from "../agents/state";
import { hookUrl, jambonz, roomOf } from "../jambonz/client";
import { clearConfExitNext, setConfExitNext } from "../jambonz/rooms";
import { log } from "../log";
import { dispositionCall } from "./calls";

type Verb = Record<string, unknown>;

export async function voicemailVerbs(campaign: Campaign, lead: Lead | null, callerId: string | null, agentName: string | null): Promise<Verb[]> {
  if (campaign.voicemailMode === "TTS" && campaign.voicemailScript) {
    const tenant = await prisma.tenant.findUnique({ where: { id: campaign.tenantId }, select: { name: true } });
    const text = renderTemplate(campaign.voicemailScript, {
      first_name: lead?.firstName ?? "there",
      last_name: lead?.lastName ?? "",
      company: tenant?.name ?? "",
      callback_number: callerId ? prettyPhone(callerId) : "",
      agent: agentName ?? "",
    });
    // Uses the jambonz account's default speech vendor; none set = silence, so a
    // file is the safer choice until the account has one.
    return [{ verb: "say", text }, { verb: "hangup" }];
  }
  if (campaign.voicemailDropAudioId) {
    const a = await prisma.audioAsset.findUnique({ where: { id: campaign.voicemailDropAudioId } });
    if (a) return [{ verb: "play", url: a.storageUrl }, { verb: "hangup" }];
  }
  return [{ verb: "hangup" }];
}

/** What the lead leg runs for the agent's "Leave voicemail": a short pause (the beep), then the message. */
export async function agentDropVerbs(callId: string): Promise<Verb[]> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true, lead: true } });
  if (!call?.campaign) return [{ verb: "hangup" }];
  const agentUser = call.agentId ? await prisma.user.findUnique({ where: { id: call.agentId }, select: { firstName: true } }) : null;
  // A beep has usually just played when the agent hears the greeting end; a short pause lands after it.
  return [{ verb: "pause", length: 1 }, ...(await voicemailVerbs(call.campaign, call.lead, call.callerId, agentUser?.firstName ?? null))];
}

/** Agent hit a machine AMD missed: redirect the lead leg to the drop hook, auto-disposition, and move on. */
export async function agentVoicemailDrop(callId: string, agentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } });
  if (!call?.campaign || call.agentId !== agentId) return { ok: false, error: "Not your call" };
  if (!call.providerCallId || call.endedAt) return { ok: false, error: "Call is not live" };
  try {
    // The drop is the conf-exit marker first (jambonz/rooms.ts): the agent's room exit hook, which fires after the
    // redirect and wins, then plays the drop instead of hanging the lead up (7 Nov: the drop never played).
    await setConfExitNext(callId, await agentDropVerbs(callId), roomOf(await getAgent(agentId), agentId));
    await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/vm-drop", { callId }), method: "POST" });
  } catch (e) {
    await clearConfExitNext(callId);
    log.warn({ err: e, callId }, "voicemail drop redirect failed");
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await prisma.call.update({ where: { id: callId }, data: { amdResult: call.amdResult ?? "MACHINE", outcome: "VOICEMAIL_DROPPED", providerData: { ...(call.providerData as object), agentDrop: true } } });
  if (call.leadId) await prisma.lead.update({ where: { id: call.leadId }, data: { lastAgentId: agentId } }).catch(() => undefined);
  // Auto-disposition with the campaign's VM code when there is one, so the agent is back to Ready at once.
  const vm = await prisma.disposition.findFirst({ where: { campaignId: call.campaign.id, active: true, OR: [{ code: "VM" }, { code: "VOICEMAIL" }, { label: { contains: "voicemail", mode: "insensitive" } }] } });
  if (vm) {
    await dispositionCall({ callId, dispositionId: vm.id, actorId: agentId, notes: "Voicemail left by agent" });
  } else {
    const live = await getAgent(agentId);
    if (live?.currentCallId === callId) await patchAgent(agentId, { state: "WRAP_UP" });
  }
  return { ok: true };
}
