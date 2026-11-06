// AI answer on an inbound queue: when the AI takes a caller, how the call
// moves to it, how it comes back to the people, and how it is finished.
//
// Transport. The engine's jambonz application is webhook based. The cascaded
// `agent` verb (speech-to-text + LLM + speech) needs a WebSocket session, so
// a caller the AI should answer is moved with live call control: a REST
// update of the call with `call_hook` = wss://<engine>/ws/ai. jambonz's
// feature-server opens the WebSocket, hands the session over and sends
// `session:new` there (http-requestor.js: an absolute ws URL on a
// `session:redirect` switches transport). Coming back is the same in reverse:
// a REST `call_hook` with our https `/jambonz/ai-handoff`, which jambonz
// POSTs as a plain webhook (ws-requestor.js) and whose verbs put the caller
// in the queue's normal human flow. No second jambonz application is needed.
import { prisma, type AiOutcome, type Queue } from "@strowger/db";
import { aiReadiness, type AiReadiness, type AiTurn, type SpeechCred } from "@strowger/shared/inbound";
import { chargeAiMinutes } from "../../billing";
import { config } from "../../config";
import { hookUrl, jambonz, jambonzConfigured } from "../../jambonz/client";
import { log } from "../../log";
import { jambonzAdmin } from "../../provision/jambonz-admin";
import { redis } from "../../redis";
import { emitToAgent, emitToTenant } from "../../realtime";
import { promptVerb, type Verbs } from "../common";
import { enterQueue } from "../queues";
import { summarizeConversation } from "./llm";

const STATE = (callId: string) => `ai:${callId}`;
const TX = (callId: string) => `aitx:${callId}`;
const DONE = (callId: string) => `aidone:${callId}`;
const DOWN = "ai:down";
/** A caller handed back by the AI goes ahead of everyone waiting. */
export const AI_HANDOFF_PRIORITY = 100;

export interface AiState {
  callId: string;
  tenantId: string;
  queueId: string;
  reason: string;
  startedAt: number;
  stt: string | null;
  tts: string | null;
  /** Set by a tool (a message taken, a callback booked); the call's outcome unless a person takes over. */
  pending?: AiOutcome | null;
  /** Characters of the system prompt, for the token estimate. */
  systemChars?: number;
}

export function aiWsUrl(): string {
  return `${config.ENGINE_PUBLIC_URL.replace(/^http/, "ws").replace(/\/+$/, "")}/ws/ai`;
}

// ── Readiness ───────────────────────────────────────────────────────────────

let credCache: { at: number; creds: SpeechCred[] | null } = { at: 0, creds: null };

/** The jambonz account's speech services (vendor and use only), cached five minutes; null when they cannot be read. */
export async function speechCreds(): Promise<SpeechCred[] | null> {
  const ttl = credCache.creds ? 300_000 : 30_000;
  if (Date.now() - credCache.at < ttl) return credCache.creds;
  if (!jambonzConfigured) return null;
  try {
    credCache = { at: Date.now(), creds: await jambonzAdmin.listSpeechCredentials() };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "jambonz speech services could not be read");
    credCache = { at: Date.now(), creds: null };
  }
  return credCache.creds;
}

type AiQueueFields = Pick<Queue, "aiSttVendor" | "aiTtsVendor" | "aiLlmVendor">;

export async function aiReadyFor(q: AiQueueFields): Promise<AiReadiness> {
  return aiReadiness({
    jambonzConfigured,
    creds: await speechCreds(),
    sttVendor: q.aiSttVendor,
    ttsVendor: q.aiTtsVendor,
    llmVendor: q.aiLlmVendor,
    anthropicKey: Boolean(config.ANTHROPIC_API_KEY),
    publicUrl: config.ENGINE_PUBLIC_URL,
  });
}

/** May the AI take a call on this queue right now? Off, not ready, or failing recently (ai:down) = no: callers go to people. */
export async function aiUsable(q: Queue): Promise<AiReadiness & { usable: boolean }> {
  const r = await aiReadyFor(q);
  const down = await redis.get(DOWN);
  return { ...r, usable: q.aiEnabled && r.ok && !down };
}

async function markAiDown(reason: string): Promise<void> {
  if (!(await redis.get(DOWN))) log.warn({ reason }, "AI answer failing: callers go to people for 10 minutes");
  await redis.set(DOWN, reason.slice(0, 200), "EX", 600);
}

// ── State and transcript ────────────────────────────────────────────────────

export async function aiState(callId: string): Promise<AiState | null> {
  const raw = await redis.get(STATE(callId));
  return raw ? (JSON.parse(raw) as AiState) : null;
}

export async function patchAiState(callId: string, patch: Partial<AiState>): Promise<void> {
  const cur = await aiState(callId);
  if (cur) await redis.set(STATE(callId), JSON.stringify({ ...cur, ...patch }), "EX", 6 * 3600);
}

export async function appendTurn(callId: string, turn: AiTurn): Promise<void> {
  if (!turn.text.trim()) return;
  await redis.rpush(TX(callId), JSON.stringify({ ...turn, text: turn.text.slice(0, 2000) }));
  await redis.expire(TX(callId), 6 * 3600);
}

export async function transcript(callId: string): Promise<AiTurn[]> {
  return (await redis.lrange(TX(callId), 0, -1)).map((r) => JSON.parse(r) as AiTurn);
}

// ── Taking a caller ─────────────────────────────────────────────────────────

async function begin(q: Queue, callId: string, reason: string, r: AiReadiness): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return;
  const state: AiState = { callId, tenantId: q.tenantId, queueId: q.id, reason, startedAt: Date.now(), stt: r.stt, tts: r.tts };
  await redis.set(STATE(callId), JSON.stringify(state), "EX", 6 * 3600);
  await prisma.call.update({ where: { id: callId }, data: { queueId: q.id, aiHandledAt: new Date(), providerData: { ...(call.providerData as object), ai: { reason, queueId: q.id, at: new Date().toISOString() } } } });
  log.info({ callId, queueId: q.id, reason, mode: q.aiMode }, "AI answer takes the call");
  emitToTenant(q.tenantId, "floor:queue", { queueId: q.id, callId, event: "ai", reason });
}

async function redirectToAi(callId: string): Promise<boolean> {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { providerCallId: true, endedAt: true } });
  if (!call?.providerCallId || call.endedAt) return false;
  try {
    await jambonz.calls.redirect(call.providerCallId, { url: aiWsUrl(), method: "POST" });
    return true;
  } catch (e) {
    log.warn({ err: e, callId }, "redirect to the AI failed");
    return false;
  }
}

/**
 * On entering the queue, inside the call's webhook reply: a short pause while
 * the REST redirect moves the call to the AI; if it never lands the pause
 * ends on `/jambonz/ai-fallback`, which queues the caller for people.
 */
export async function aiEntryVerbs(q: Queue, callId: string, reason: string): Promise<Verbs | null> {
  const r = await aiUsable(q);
  if (!r.usable) return null;
  await begin(q, callId, reason, r);
  setTimeout(() => {
    void redirectToAi(callId).then((ok) => (ok ? undefined : markAiDown("redirect failed")));
  }, 400);
  return [
    { verb: "pause", length: 5 },
    { verb: "redirect", actionHook: hookUrl("/jambonz/ai-fallback", { callId }) },
  ];
}

/** A caller already waiting (OVERFLOW): moved to the AI now; false (and they keep their place) when the move fails. */
export async function aiTakeWaiting(q: Queue, callId: string, reason: string): Promise<boolean> {
  const r = await aiUsable(q);
  if (!r.usable) return false;
  await begin(q, callId, reason, r);
  if (await redirectToAi(callId)) return true;
  await redis.del(STATE(callId));
  await prisma.call.update({ where: { id: callId }, data: { aiHandledAt: null } }).catch(() => undefined);
  await markAiDown("redirect failed");
  return false;
}

/** The pause after entry ran out: the AI never picked up. People take the call; the AI is skipped for 10 minutes. */
export async function aiFallbackVerbs(callId: string): Promise<Verbs> {
  const state = await aiState(callId);
  await redis.del(STATE(callId));
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: { include: { schedule: true } } } });
  if (!call?.queue) return [{ verb: "hangup" }];
  await markAiDown("the AI session did not start");
  log.warn({ callId, queueId: call.queueId, reason: state?.reason }, "AI did not pick up: queueing for people");
  await prisma.call.update({ where: { id: callId }, data: { aiHandledAt: null, providerData: { ...(call.providerData as object), aiSkipped: true } } });
  return enterQueue(call.queue, callId);
}

// ── Finishing ───────────────────────────────────────────────────────────────

/**
 * The AI's part of the call is over: the outcome, the transcript, the minutes
 * and the usage. Once per call. `resolved` / `hangup` give way to an outcome a
 * tool set (a message, a callback).
 */
export async function finishAi(callId: string, how: "handoff" | "resolved" | "hangup", note?: string): Promise<boolean> {
  const first = await redis.set(DONE(callId), how, "EX", 6 * 3600, "NX");
  if (!first) return false;
  const state = await aiState(callId);
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call?.aiHandledAt) return false;
  const turns = await transcript(callId);
  const outcome: AiOutcome = how === "handoff" ? "HANDOFF" : (state?.pending ?? (how === "resolved" ? "RESOLVED" : "HANGUP"));
  const now = new Date();
  const seconds = Math.max(0, Math.round((now.getTime() - call.aiHandledAt.getTime()) / 1000));
  const lastCaller = [...turns].reverse().find((t) => t.role === "caller")?.text;
  const quick = how === "handoff" ? `Handed over: ${note ?? "the caller asked for a person"}.${lastCaller ? ` Last said: "${lastCaller.slice(0, 200)}"` : ""}` : null;
  await prisma.call.update({
    where: { id: callId },
    data: { aiOutcome: outcome, aiEndedAt: now, aiSeconds: seconds, aiTranscript: turns.map((t) => ({ role: t.role, text: t.text, at: new Date(t.at).toISOString() })), ...(quick ? { aiSummary: quick } : {}) },
  });
  await redis.del(STATE(callId));
  log.info({ callId, outcome, seconds, turns: turns.length, note }, "AI answer finished");
  emitToTenant(call.tenantId, "floor:queue", { queueId: call.queueId, callId, event: "ai_end", outcome });
  void chargeAiMinutes(callId, state?.systemChars ?? 0).catch((e) => log.warn({ err: e, callId }, "AI usage charge failed"));
  return true;
}

/** Hand the caller to people: finish the AI part, then move the call back to the webhook flow (`/jambonz/ai-handoff`). */
export async function handOff(callId: string, reason: string): Promise<void> {
  if (!(await finishAi(callId, "handoff", reason))) return;
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call?.providerCallId || call.endedAt) return;
  await prisma.call.update({ where: { id: callId }, data: { providerData: { ...(call.providerData as object), aiHandoff: { reason, at: new Date().toISOString() } } } });
  try {
    await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/ai-handoff", { callId }), method: "POST" });
  } catch (e) {
    log.error({ err: e, callId }, "AI hand-off redirect failed");
  }
  void writeSummary(callId);
}

/** The caller hung up (status hook): finish the AI part if it was still running. */
export async function aiCallEnded(callId: string): Promise<void> {
  if (await aiState(callId)) await finishAi(callId, "hangup");
}

/** `/jambonz/ai-handoff`: a word, then the queue's own human flow, ahead of the line and with no forced hold. */
export async function aiHandoffVerbs(callId: string): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: { include: { schedule: true } } } });
  if (!call?.queue) return [{ verb: "hangup" }];
  const word = await promptVerb(null, "One moment while I connect you with a member of our team.");
  return [...(word ? [word] : []), ...(await enterQueue(call.queue, callId, 0, { exemptHold: true, priorityBoost: AI_HANDOFF_PRIORITY }))];
}

/** The proper summary for the agent's screen pop; the quick one stands until it lands. */
async function writeSummary(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { tenantId: true, aiTranscript: true, agentId: true, bridgedAt: true } });
  const turns = (call?.aiTranscript as Array<{ role: "caller" | "ai"; text: string }> | null) ?? [];
  if (!call || turns.length === 0) return;
  const summary = await summarizeConversation(call.tenantId, turns, callId);
  if (!summary) return;
  await prisma.call.update({ where: { id: callId }, data: { aiSummary: summary } });
  const fresh = await prisma.call.findUnique({ where: { id: callId }, select: { agentId: true, bridgedAt: true, endedAt: true } });
  if (fresh?.agentId && !fresh.endedAt) emitToAgent(fresh.agentId, "call:update", { callId, status: fresh.bridgedAt ? "bridged" : "answered", aiSummary: summary });
}
