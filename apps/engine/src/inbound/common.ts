// Pieces every inbound path shares: audio lookups, the join into an agent's
// room, claiming an agent, voicemail boxes, IVR menus, and the spoken
// prompts (text to speech, with a fallback to silence when it is down).
import { liveLeadVerbs } from "../assist/live";
import { prisma, type Ivr, type VoicemailBox } from "@strowger/db";
import { getAgent, lockAgent, patchAgent, unlockAgent, type AgentLive } from "../agents/state";
import { config } from "../config";
import { hookUrl } from "../jambonz/client";
import { leadJoinVerb } from "../jambonz/rooms";
import { leadCallBridged } from "../dialer/calls";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";

type Verb = Record<string, unknown>;
export type Verbs = Verb[];

export async function audio(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const a = await prisma.audioAsset.findUnique({ where: { id } });
  return a?.storageUrl ?? null;
}

// ── Text to speech ──────────────────────────────────────────────────────────

const TTS_DOWN = "tts:down";

/** A `say` verb with the configured voice, or the application's default when none is set. */
export function sayVerb(text: string): Verb {
  return {
    verb: "say",
    text,
    ...(config.TTS_VENDOR ? { synthesizer: { vendor: config.TTS_VENDOR, language: config.TTS_LANGUAGE, ...(config.TTS_VOICE ? { voice: config.TTS_VOICE } : {}) } } : {}),
  };
}

/** False for 15 minutes after jambonz reported a speech failure: announcements go quiet instead of erroring. */
export async function ttsAvailable(): Promise<boolean> {
  return !(await redis.get(TTS_DOWN));
}

export async function markTtsDown(reason: string): Promise<void> {
  const was = await redis.get(TTS_DOWN);
  await redis.set(TTS_DOWN, reason.slice(0, 200), "EX", 15 * 60);
  if (!was) log.warn({ reason }, "text to speech failing: spoken queue prompts are off for 15 minutes");
}

/** A recorded prompt when there is one, else the text spoken, else nothing (speech down). */
export async function promptVerb(audioId: string | null | undefined, text: string): Promise<Verb | null> {
  const url = await audio(audioId);
  if (url) return { verb: "play", url };
  return (await ttsAvailable()) ? sayVerb(text) : null;
}

/** The prompt as the nested `play`/`say` a gather takes. */
export async function gatherPrompt(audioId: string | null | undefined, text: string): Promise<Record<string, unknown>> {
  const p = await promptVerb(audioId, text);
  if (!p) return {};
  const { verb, ...rest } = p;
  return verb === "play" ? { play: rest } : { say: rest };
}

// ── Agents ──────────────────────────────────────────────────────────────────

export function isFree(a: AgentLive): boolean {
  return a.state === "READY" && Boolean(a.agentCallSid) && !a.currentCallId && !a.reservedLeadId;
}

/**
 * Conference-join verbs for an inbound caller into an agent's room (with the live transcription first, when the
 * queue or campaign has it on). Only while the agent still has a line and this call (owner, 7 Nov); otherwise the
 * caller goes back in its queue (or, with no queue, to the agent's box). Sending the join counts as bridged.
 */
export async function joinAgentVerbs(callId: string, tenantId: string, agentId: string): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, tenantId: true, agentId: true, campaignId: true, queueId: true } });
  const agent = await getAgent(agentId);
  if (!call || !agent?.agentCallSid || agent.currentCallId !== callId) {
    log.warn({ callId, agentId, agentCallSid: agent?.agentCallSid ?? null, currentCallId: agent?.currentCallId ?? null }, "inbound bridge: the agent no longer has a line or this call");
    if (!call) return [{ verb: "hangup" }];
    const { requeueCaller } = await import("./queues");
    return requeueCaller(callId, tenantId, agentId);
  }
  const live = await liveLeadVerbs({ ...call, agentId: call.agentId ?? agentId });
  const verbs: Verbs = [...live, leadJoinVerb({ callId, tenantId, agentId, agent }), { verb: "hangup" }];
  await leadCallBridged(callId);
  return verbs;
}

/**
 * Give an answered inbound call to this agent. Atomic (owner, 7 Nov): `agentclaim:<userId>` first, then the
 * agent re-read and still free; false = someone else got them, try the next agent.
 */
export async function claimAgent(agent: AgentLive, callId: string, leadId: string | null, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (!(await lockAgent(agent.userId, callId))) return false;
  try {
    const fresh = await getAgent(agent.userId);
    if (!fresh || !isFree(fresh)) return false;
    await prisma.call.update({ where: { id: callId }, data: { agentId: agent.userId } });
    await patchAgent(agent.userId, { state: "ON_CALL", currentCallId: callId, reservedLeadId: null, wrapUntil: null });
  } finally {
    await unlockAgent(agent.userId, callId);
  }
  if (leadId) await prisma.lead.update({ where: { id: leadId }, data: { ownerId: agent.userId } });
  emitToAgent(agent.userId, "call:update", { callId, status: "answered", leadId, inbound: true, ...extra });
  emitToTenant(agent.tenantId, "floor:call", { callId, status: "inbound", agentId: agent.userId });
  return true;
}

// ── Voicemail ───────────────────────────────────────────────────────────────

export async function boxForUser(tenantId: string, userId: string): Promise<VoicemailBox> {
  const existing = await prisma.voicemailBox.findFirst({ where: { tenantId, ownerId: userId } });
  if (existing) return existing;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return prisma.voicemailBox.create({ data: { tenantId, ownerId: userId, name: `${u.firstName ?? u.email}'s voicemail` } });
}

/** The queue's own box, created as "<Queue> voicemail" the first time it is needed. */
export async function boxForQueue(q: { id: string; tenantId: string; name: string; voicemailBoxId: string | null }): Promise<VoicemailBox> {
  if (q.voicemailBoxId) {
    const b = await prisma.voicemailBox.findUnique({ where: { id: q.voicemailBoxId } });
    if (b) return b;
  }
  const box = await prisma.voicemailBox.upsert({ where: { tenantId_name: { tenantId: q.tenantId, name: `${q.name} voicemail` } }, create: { tenantId: q.tenantId, name: `${q.name} voicemail` }, update: {} });
  await prisma.queue.update({ where: { id: q.id }, data: { voicemailBoxId: box.id } });
  return box;
}

/** Greeting, beep, then stream the caller's audio to our recorder. */
export async function voicemailVerbs(box: VoicemailBox, callId: string, fromPhone: string): Promise<Verbs> {
  const vm = await prisma.voicemail.create({ data: { tenantId: box.tenantId, boxId: box.id, callId, fromPhone, assigneeId: box.ownerId } });
  const greeting = await audio(box.greetingAudioId);
  const wsBase = config.ENGINE_PUBLIC_URL.replace(/^http/, "ws");
  return [
    ...(greeting ? [{ verb: "play", url: greeting }] : [{ verb: "pause", length: 1 }]),
    { verb: "play", url: `${config.WEB_PUBLIC_URL}/beep.wav` },
    { verb: "listen", url: `${wsBase}/audio/voicemail?vmId=${vm.id}`, sampleRate: 8000, timeout: 120, finishOnKey: "#", mixType: "mono", playBeep: false },
    { verb: "hangup" },
  ];
}

// ── IVR ─────────────────────────────────────────────────────────────────────

export async function ivrVerbs(ivr: Ivr, callId: string, attempt = 1): Promise<Verbs> {
  const greeting = await audio(ivr.greetingAudioId);
  return [
    {
      verb: "gather",
      input: ["digits"],
      numDigits: ivr.allowExtensions ? 4 : 1,
      finishOnKey: "#",
      timeout: ivr.timeoutSeconds,
      interDigitTimeout: 2,
      actionHook: hookUrl("/jambonz/ivr", { ivrId: ivr.id, callId, attempt: String(attempt) }),
      ...(greeting ? { play: { url: greeting } } : {}),
    },
    { verb: "redirect", actionHook: hookUrl("/jambonz/ivr", { ivrId: ivr.id, callId, attempt: String(attempt + 1), timeout: "1" }) },
  ];
}
