// Live transcription and agent assist (HANDOFF "Live transcription and agent
// assist").
//
// Legs. A call in Strowger is two jambonz calls in one conference room: the
// lead's leg and the agent's nailed-up leg. Each is transcribed on its own
// (`channel: 1`, the leg's own voice) and labelled by leg: CUSTOMER from the
// lead's, AGENT from the agent's. Dual-channel on one leg was not used: in a
// conference the lead leg's far end (channel 2) is the room's mix, which is
// the agent plus anyone barging and a warm-transfer destination, and one leg
// carries one background transcribe; two legs is simpler and labels itself.
//
//   lead leg   `config.transcribe` in the verbs that answer it (outbound
//              answer, or the inbound bridge), interim on, hook
//              /jambonz/transcript?callId=…&leg=lead. Shared with screener
//              detection (the same hook checks the first 12 s of finals).
//   agent leg  REST cannot start a transcription on a live call (only
//              `transcribe_status` pause / resume), and the agent's leg is up
//              all session. So when the workspace has transcription on
//              anywhere, the leg's verbs at login carry `config.transcribe`
//              (hook /jambonz/transcript?agentId=…&leg=agent), it is paused
//              3 s later, resumed when a transcribed call is bridged, and
//              paused again when the lead leaves or the agent leaves a
//              transfer. Results arriving with no call to go to are paused
//              again; if that keeps happening `ltx:pause-broken` stops new
//              agent legs from carrying transcription for a day.
//
// Everything is gated by the campaign (or inbound queue) switch and by a
// speech-to-text vendor on the jambonz account; off means no verb changes.
import { prisma, type Call } from "@strowger/db";
import {
  ASSIST_CONTEXT_TURNS,
  ASSIST_DEBOUNCE_MS,
  aiSummaryNote,
  appendTurn,
  assistAllowed,
  assistModel,
  clampAssistLimits,
  coverSteps,
  isFiller,
  matchRebuttal,
  pickSuggestedDisposition,
  readTranscript,
  scriptSteps,
  transcriptionReadiness,
  type ScriptStep,
  type Speaker,
  type TranscriptionReadiness,
  type TranscriptTurn,
} from "@strowger/shared/assist";
import { DEFAULT_BANNED_PHRASES, DEFAULT_DISCLOSURE_PHRASES, bannedPhraseAlert, disclosureAlert, disclosureHeard, disclosureState, findBannedPhrases, parsePhraseList, type LiveAlert } from "@strowger/shared/compliance";
import { getAgent } from "../agents/state";
import { chargeTranscription } from "../billing";
import { config } from "../config";
import { speechCreds } from "../inbound/ai/control";
import { hookUrl, jambonz, jambonzConfigured } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";
import { watchersOf } from "../supervise";
import { coachConfigured, suggestNextLine, summarizeCall } from "./coach";

type Verb = Record<string, unknown>;

const STATE = (callId: string) => `ltx:${callId}`;
const TURNS = (callId: string) => `ltxt:${callId}`;
/** The agent's leg that carries a (paused) transcription: its call_sid. */
const AGENT_LEG = (userId: string) => `ltxleg:${userId}`;
/** The call the agent's transcription is feeding right now. */
const AGENT_ON = (userId: string) => `ltxa:${userId}`;
const PAUSE_BROKEN = "ltx:pause-broken";
const ORPHANS = (sid: string) => `ltxorphan:${sid}`;
const TTL = 6 * 3600;

export interface LiveState {
  callId: string;
  tenantId: string;
  agentId: string | null;
  campaignId: string | null;
  campaignName: string;
  stt: string;
  assist: boolean;
  model: string;
  minGapSeconds: number;
  maxPerCall: number;
  disclosureRequired: boolean;
  playedByFile: boolean;
  disclosurePhrases: string[];
  bannedPhrases: string[];
  summary: boolean;
  suggestDisposition: boolean;
  rebuttals: Array<{ objection: string; response: string }>;
  script: string | null;
  steps: ScriptStep[];
  covered: number[];
  leadStartedAt: number;
  leadStoppedAt: number | null;
  bridgedAt: number | null;
  agentSid: string | null;
  agentStartedAt: number | null;
  agentSeconds: number;
  /** Why the agent's side is not transcribed, when it is not. */
  agentSideMissing: string | null;
  disclosureHeardAt: number | null;
  disclosureAlerted: boolean;
  lastAssistAt: number | null;
  assistUsed: number;
  done: boolean;
}

async function load(callId: string): Promise<LiveState | null> {
  const raw = await redis.get(STATE(callId));
  return raw ? (JSON.parse(raw) as LiveState) : null;
}

async function save(s: LiveState): Promise<void> {
  await redis.set(STATE(s.callId), JSON.stringify(s), "EX", s.done ? 3600 : TTL);
}

async function patch(callId: string, p: Partial<LiveState>): Promise<LiveState | null> {
  const s = await load(callId);
  if (!s) return null;
  const next = { ...s, ...p };
  await save(next);
  return next;
}

// ── Readiness ───────────────────────────────────────────────────────────────

const STT_DOWN = "live:stt-down";

/**
 * jambonz reported a speech-to-text failure (alert webhook): no new call gets a
 * transcription for an hour, so calls keep their audio and their hang-up. A
 * broken transcription on 6 Nov left two calls silent and impossible to end.
 */
export async function markSttDown(reason: string): Promise<void> {
  await redis.set(STT_DOWN, reason.slice(0, 300), "EX", 3600);
  log.error({ reason }, "live transcription paused for an hour: jambonz reported a speech-to-text failure");
}

/** Can calls be transcribed at all (jambonz configured, an STT vendor on the account)? Cached with the speech services. */
export async function transcriptionReady(): Promise<TranscriptionReadiness> {
  const down = await redis.get(STT_DOWN).catch(() => null);
  if (down) return { ok: false, stt: null, problems: [`Transcription is paused for up to an hour: jambonz reported a speech-to-text failure (${down}). Check the speech-to-text vendor in jambonz (Account → Speech services).`] };
  return transcriptionReadiness({ jambonzConfigured, creds: await speechCreds(), preferred: config.SCREENER_STT_VENDOR ?? null });
}

let tenantCache = new Map<string, { at: number; on: boolean }>();

/** Does the workspace have transcription switched on anywhere (an active campaign or a queue)? 60 s cache. */
async function tenantTranscribes(tenantId: string): Promise<boolean> {
  const hit = tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.on;
  const [c, q] = await Promise.all([prisma.campaign.count({ where: { tenantId, transcriptionOn: true, status: { not: "ARCHIVED" } } }), prisma.queue.count({ where: { tenantId, transcriptionOn: true } })]);
  const on = c + q > 0;
  if (tenantCache.size > 500) tenantCache = new Map();
  tenantCache.set(tenantId, { at: Date.now(), on });
  return on;
}

// ── Settings for a call ─────────────────────────────────────────────────────

type CallRef = Pick<Call, "id" | "tenantId" | "agentId" | "campaignId" | "queueId">;

async function settingsFor(call: CallRef) {
  const queue = call.queueId ? await prisma.queue.findUnique({ where: { id: call.queueId }, select: { transcriptionOn: true, liveAssistOn: true, campaignId: true } }) : null;
  const campaignId = call.campaignId ?? queue?.campaignId ?? null;
  const campaign = campaignId
    ? await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, name: true, transcriptionOn: true, liveAssistOn: true, assistModel: true, assistMinGapSeconds: true, assistMaxPerCall: true, spokenDisclosureRequired: true, disclosureOn: true, disclosureAudioId: true, disclosurePhrases: true, bannedPhrases: true, postCallSummaryOn: true, suggestDispositionOn: true, rebuttals: true },
      })
    : null;
  // An inbound queue call follows the queue's own switches; everything else the campaign's.
  const transcription = queue ? queue.transcriptionOn : Boolean(campaign?.transcriptionOn);
  if (!transcription) return null;
  const limits = clampAssistLimits(campaign?.assistMinGapSeconds ?? 8, campaign?.assistMaxPerCall ?? 40);
  const script = campaign ? ((await prisma.script.findFirst({ where: { campaignId: campaign.id }, orderBy: { version: "desc" }, select: { body: true } }))?.body ?? null) : null;
  return {
    campaignId: campaign?.id ?? null,
    campaignName: campaign?.name ?? "Inbound",
    assist: queue ? queue.liveAssistOn : Boolean(campaign?.liveAssistOn),
    model: assistModel(campaign?.assistModel),
    ...limits,
    // Outbound plays the campaign's disclosure file to the lead before the join (jambonz/routes joinVerbs): that file is the disclosure.
    disclosureRequired: Boolean(campaign?.spokenDisclosureRequired),
    playedByFile: Boolean(!call.queueId && campaign?.disclosureOn && campaign.disclosureAudioId),
    disclosurePhrases: parsePhraseList(campaign?.disclosurePhrases?.length ? campaign.disclosurePhrases : DEFAULT_DISCLOSURE_PHRASES),
    bannedPhrases: parsePhraseList(campaign ? campaign.bannedPhrases : DEFAULT_BANNED_PHRASES),
    summary: Boolean(campaign?.postCallSummaryOn),
    suggestDisposition: Boolean(campaign?.suggestDispositionOn),
    rebuttals: ((campaign?.rebuttals as Array<{ objection: string; response: string }> | null) ?? []).filter((r) => r?.objection && r.response).slice(0, 200),
    script,
  };
}

function transcribeVerb(params: Record<string, string>, stt: string): Verb {
  return {
    verb: "config",
    transcribe: {
      enable: true,
      transcriptionHook: hookUrl("/jambonz/transcript", params),
      channel: 1,
      recognizer: { vendor: stt, language: config.SCREENER_STT_LANGUAGE, interim: true, punctuation: true },
    },
  };
}

// ── Starting ────────────────────────────────────────────────────────────────

/**
 * Verbs to put before the lead leg's join (outbound answer, inbound bridge):
 * a background transcription of the lead, when the call's campaign or queue
 * has it on and the account has an STT vendor. [] otherwise (calls unchanged).
 */
export async function liveLeadVerbs(call: CallRef): Promise<Verb[]> {
  try {
    const existing = await load(call.id);
    if (existing) return []; // already transcribing this leg (a second join verb array for the same leg)
    const set = await settingsFor(call);
    if (!set) return [];
    const ready = await transcriptionReady();
    if (!ready.ok || !ready.stt) {
      log.warn({ callId: call.id, problems: ready.problems }, "live transcription is on but cannot run: no speech-to-text");
      return [];
    }
    const s: LiveState = {
      callId: call.id,
      tenantId: call.tenantId,
      agentId: call.agentId,
      ...set,
      stt: ready.stt,
      steps: scriptSteps(set.script),
      covered: [],
      leadStartedAt: Date.now(),
      leadStoppedAt: null,
      bridgedAt: null,
      agentSid: null,
      agentStartedAt: null,
      agentSeconds: 0,
      agentSideMissing: null,
      disclosureHeardAt: null,
      disclosureAlerted: false,
      lastAssistAt: null,
      assistUsed: 0,
      done: false,
    };
    await save(s);
    return [transcribeVerb({ callId: call.id, leg: "lead" }, ready.stt)];
  } catch (e) {
    log.warn({ err: e, callId: call.id }, "live transcription setup failed; call goes on without it");
    return [];
  }
}

/**
 * Off (owner, 7 Nov: one-way audio again, "make sure it doesn't happen anymore"). Transcription on the agent's
 * nailed-up line meant a transcribe config on that line plus a REST pause/resume on it around every call, on the
 * one leg every call's audio depends on. Both one-way incidents with transcription on (6 and 7 Nov) broke the
 * agent's side while the lead's side transcribed fine, and in two days not one agent-side result ever arrived.
 * So the agent's line is never touched by transcription; only the lead leg is transcribed.
 */
const AGENT_LEG_TRANSCRIPTION = false;

/**
 * The recognizer jambonz's answering-machine detection must use. Without one, AMD takes the application's
 * default speech vendor, which on this account is Cartesia (voice only): every AMD call raised "no-stt", the
 * verdict never came, and the alert paused live transcription for an hour. null = no usable speech-to-text,
 * so the caller skips AMD rather than run it on a vendor that cannot listen.
 */
export async function amdRecognizer(): Promise<{ vendor: string; language: string } | null> {
  try {
    const ready = await transcriptionReady();
    return ready.ok && ready.stt ? { vendor: ready.stt, language: config.SCREENER_STT_LANGUAGE } : null;
  } catch {
    return null;
  }
}

/**
 * Verbs before the agent's nailed-up conference join: a transcription that is
 * paused a few seconds later and resumed per call. Only when the workspace has
 * transcription on somewhere, the account can do it, and pausing works.
 */
export async function liveAgentLegVerbs(userId: string, tenantId: string, callSid: string): Promise<Verb[]> {
  try {
    if (!AGENT_LEG_TRANSCRIPTION) return [];
    if (!(await tenantTranscribes(tenantId))) return [];
    if (await redis.get(PAUSE_BROKEN)) return [];
    const ready = await transcriptionReady();
    if (!ready.ok || !ready.stt) return [];
    await redis.set(AGENT_LEG(userId), callSid, "EX", 24 * 3600);
    setTimeout(() => void pauseAgentIfIdle(userId, callSid), 3000);
    return [transcribeVerb({ agentId: userId, leg: "agent" }, ready.stt)];
  } catch (e) {
    log.warn({ err: e, userId }, "agent leg transcription setup failed; the line comes up without it");
    return [];
  }
}

async function setTranscribe(sid: string, status: "pause" | "resume"): Promise<boolean> {
  try {
    await jambonz.calls.update(sid, { transcribe_status: status });
    return true;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e), sid, status }, "transcribe_status update failed");
    return false;
  }
}

async function pauseAgentIfIdle(userId: string, sid: string): Promise<void> {
  if ((await redis.get(AGENT_ON(userId))) && (await redis.get(AGENT_LEG(userId))) === sid) return;
  await setTranscribe(sid, "pause");
}

/** The lead joined the agent (conference join): the agent's side starts, the disclosure clock starts. */
export async function liveCallBridged(callId: string): Promise<void> {
  const s = await load(callId);
  if (!s || s.done || s.bridgedAt) return;
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { agentId: true } });
  const agentId = call?.agentId ?? s.agentId;
  const now = Date.now();
  let agentSid: string | null = null;
  let missing: string | null = null;
  if (agentId) {
    const agent = await getAgent(agentId);
    const legSid = await redis.get(AGENT_LEG(agentId));
    if (agent?.agentCallSid && legSid === agent.agentCallSid) {
      if (await setTranscribe(legSid, "resume")) {
        agentSid = legSid;
        await redis.set(AGENT_ON(agentId), callId, "EX", TTL);
      } else missing = "Your side could not be started; only the customer is transcribed on this call.";
    } else missing = !AGENT_LEG_TRANSCRIPTION ? "Only the customer is transcribed: your own line is kept free of transcription so your audio is never affected." : (await redis.get(PAUSE_BROKEN)) ? "Your side is not transcribed today (the engine could not pause it between calls)." : "Your line came up before transcription was switched on: your side starts after your next log in.";
  }
  const next = await patch(callId, { agentId, bridgedAt: now, agentSid, agentStartedAt: agentSid ? now : null, agentSideMissing: missing });
  if (!next) return;
  await emitLive(next, "transcript:status", { callId, on: true, agentSide: Boolean(agentSid), message: missing });
  await emitScript(next);
  if (next.disclosureRequired && !next.playedByFile && agentSid) {
    setTimeout(() => void checkDisclosure(callId), 30_000 + 200);
  }
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface SttResult {
  text: string;
  final: boolean;
}

/** jambonz posted a transcription result for a lead leg (the screener check runs separately). */
export async function leadTranscript(callId: string, r: SttResult): Promise<void> {
  const s = await load(callId);
  if (!s || s.done) return;
  await onResult(s, "CUSTOMER", r);
}

/** A result from an agent's leg: goes to the call it is feeding, or the leg is paused again. */
export async function agentTranscript(userId: string, callSid: string | undefined, r: SttResult): Promise<void> {
  const callId = await redis.get(AGENT_ON(userId));
  const s = callId ? await load(callId) : null;
  if (!s || s.done || (callSid && s.agentSid && s.agentSid !== callSid)) {
    await orphan(userId, callSid ?? (await redis.get(AGENT_LEG(userId))) ?? "");
    return;
  }
  await onResult(s, "AGENT", r);
}

/** Speech from an agent's leg with no call: pause it again; when that keeps failing, stop starting it. */
async function orphan(userId: string, sid: string): Promise<void> {
  if (!sid) return;
  const n = await redis.incr(ORPHANS(sid));
  await redis.expire(ORPHANS(sid), 600);
  if (n === 1 || n % 10 === 0) {
    log.info({ userId, sid, n }, "agent transcription result between calls: pausing it");
    await setTranscribe(sid, "pause");
  }
  if (n === 40) {
    log.error({ userId, sid }, "agent transcription would not pause: new agent lines start without transcription for 24 hours (ltx:pause-broken)");
    await redis.set(PAUSE_BROKEN, sid, "EX", 24 * 3600);
  }
}

async function emitLive(s: Pick<LiveState, "agentId" | "tenantId">, event: string, payload: Record<string, unknown>): Promise<void> {
  if (!s.agentId) return;
  const p = { ...payload, agentId: s.agentId };
  emitToAgent(s.agentId, event, p);
  for (const sup of await watchersOf(s.agentId)) if (sup !== s.agentId) emitToAgent(sup, event, p);
}

async function onResult(s: LiveState, speaker: Speaker, r: SttResult): Promise<void> {
  const text = r.text.replace(/\s+/g, " ").trim();
  if (!text) return;
  const at = Date.now();
  if (!r.final) {
    await emitLive(s, "transcript:partial", { callId: s.callId, speaker, text: text.slice(0, 500), at });
    return;
  }
  const turn: TranscriptTurn = { speaker, text: text.slice(0, 2000), at };
  await redis.rpush(TURNS(s.callId), JSON.stringify(turn));
  await redis.ltrim(TURNS(s.callId), -400, -1);
  await redis.expire(TURNS(s.callId), TTL);
  await emitLive(s, "transcript:final", { callId: s.callId, ...turn });
  void persistTranscript(s.callId);
  if (speaker === "AGENT") await agentSaid(s, turn);
  else if (s.assist) queueAssist(s.callId, turn.text);
}

async function turnsOf(callId: string): Promise<TranscriptTurn[]> {
  const raw = await redis.lrange(TURNS(callId), 0, -1);
  return readTranscript(raw.map((x) => JSON.parse(x) as unknown));
}

const persisting = new Map<string, Promise<void>>();
/** Write the finals so far to Call.transcript (capped). One write at a time per call; the last one wins. */
async function persistTranscript(callId: string): Promise<void> {
  const prev = persisting.get(callId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const turns = (await turnsOf(callId)).reduce<TranscriptTurn[]>((acc, t) => appendTurn(acc, t), []);
    await prisma.call.update({ where: { id: callId }, data: { transcript: turns as unknown as object } }).catch((e) => log.warn({ err: e, callId }, "transcript write failed"));
  });
  persisting.set(callId, next);
  await next;
  if (persisting.get(callId) === next) persisting.delete(callId);
}

// ── Agent speech: compliance and script progress ────────────────────────────

async function raise(s: LiveState, alert: LiveAlert): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: s.callId }, select: { complianceAlerts: true, leadId: true } });
  const list = (Array.isArray(call?.complianceAlerts) ? (call.complianceAlerts as unknown as LiveAlert[]) : []).concat([alert]).slice(-50);
  await prisma.call.update({ where: { id: s.callId }, data: { complianceAlerts: list as unknown as object } }).catch(() => undefined);
  if (call?.leadId) await prisma.leadEvent.create({ data: { tenantId: s.tenantId, leadId: call.leadId, kind: "NOTE", actorId: s.agentId, data: { callId: s.callId, note: `Compliance: ${alert.message}`, compliance: alert.rule } } }).catch(() => undefined);
  await emitLive(s, "compliance:alert", { callId: s.callId, ...alert });
  emitToTenant(s.tenantId, "floor:compliance", { callId: s.callId, agentId: s.agentId, ...alert });
  log.info({ callId: s.callId, rule: alert.rule, phrase: alert.phrase }, "live compliance alert");
}

async function agentSaid(s: LiveState, turn: TranscriptTurn): Promise<void> {
  // Banned phrases: every time one is said.
  for (const phrase of findBannedPhrases(turn.text, s.bannedPhrases)) await raise(s, bannedPhraseAlert(phrase, turn.text, turn.at));
  // The disclosure, heard.
  if (s.disclosureHeardAt === null && disclosureHeard(turn.text, s.disclosurePhrases)) {
    const next = await patch(s.callId, { disclosureHeardAt: turn.at });
    if (next && s.disclosureAlerted) await emitLive(s, "compliance:clear", { callId: s.callId, rule: "disclosure_missing" });
    if (next) s = next;
  }
  // Script progress.
  if (s.steps.length) {
    const said = (await turnsOf(s.callId)).filter((t) => t.speaker === "AGENT").map((t) => t.text);
    const p = coverSteps(s.steps, said);
    if (p.covered.length !== s.covered.length) {
      const next = await patch(s.callId, { covered: p.covered });
      if (next) await emitScript(next);
    }
  }
}

async function emitScript(s: LiveState): Promise<void> {
  if (!s.steps.length) return;
  const next = s.steps.find((x) => !s.covered.includes(x.index))?.index ?? null;
  await emitLive(s, "assist:script", { callId: s.callId, steps: s.steps.map((x) => ({ index: x.index, title: x.title })), covered: s.covered, next });
}

async function checkDisclosure(callId: string): Promise<void> {
  const s = await load(callId);
  if (!s || s.done || s.disclosureAlerted) return;
  const state = disclosureState({ required: s.disclosureRequired, playedByFile: s.playedByFile, agentTranscribed: Boolean(s.agentSid), bridgedAt: s.bridgedAt, heardAt: s.disclosureHeardAt, now: Date.now() });
  if (state !== "overdue") return;
  const next = await patch(callId, { disclosureAlerted: true });
  if (next) await raise(next, disclosureAlert(Date.now()));
}

// ── Customer speech: assist ─────────────────────────────────────────────────

const pending = new Map<string, { timer: NodeJS.Timeout; parts: string[] }>();
const inflight = new Set<string>();

function queueAssist(callId: string, text: string): void {
  const cur = pending.get(callId);
  if (cur) clearTimeout(cur.timer);
  const parts = [...(cur?.parts ?? []), text].slice(-4);
  const timer = setTimeout(() => {
    pending.delete(callId);
    void runAssist(callId, parts.join(" ")).catch((e) => log.warn({ err: e, callId }, "live assist failed"));
  }, ASSIST_DEBOUNCE_MS);
  pending.set(callId, { timer, parts });
}

async function runAssist(callId: string, heard: string): Promise<void> {
  if (isFiller(heard)) return;
  const s = await load(callId);
  if (!s || s.done || !s.assist) return;
  // The library first: an instant "Say this" card.
  const m = matchRebuttal(heard, s.rebuttals);
  if (m) {
    await emitLive(s, "assist:rebuttal", { callId, heard: heard.slice(0, 300), objection: m.objection, response: m.response, score: m.score, at: Date.now() });
    return;
  }
  if (!coachConfigured() || inflight.has(callId)) return;
  const now = Date.now();
  const ok = assistAllowed({ lastAt: s.lastAssistAt, used: s.assistUsed }, { minGapSeconds: s.minGapSeconds, maxPerCall: s.maxPerCall }, now);
  if (!ok.ok) return;
  inflight.add(callId);
  try {
    await patch(callId, { lastAssistAt: now, assistUsed: s.assistUsed + 1 });
    await prisma.call.update({ where: { id: callId }, data: { assistCalls: { increment: 1 } } }).catch(() => undefined);
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { tenant: { select: { name: true } }, queueId: true, lead: { select: { firstName: true, lastName: true, city: true, state: true, leadType: true, notes: true } } } });
    const id = `${callId}:${now}`;
    await emitLive(s, "assist:suggestion", { callId, id, status: "thinking", lines: [], tone: null, heard: heard.slice(0, 300), at: now });
    const turns = (await turnsOf(callId)).slice(-ASSIST_CONTEXT_TURNS);
    const out = await suggestNextLine(
      {
        tenantId: s.tenantId,
        callId,
        model: s.model,
        business: call?.tenant.name ?? "the company",
        campaign: s.campaignName,
        goal: call?.queueId ? "service" : "sale",
        script: s.script,
        rebuttals: s.rebuttals,
        bannedPhrases: s.bannedPhrases,
        lead: call?.lead ? { name: [call.lead.firstName, call.lead.lastName].filter(Boolean).join(" ") || null, city: call.lead.city, state: call.lead.state, leadType: call.lead.leadType, notes: call.lead.notes } : null,
        turns,
      },
      (lines) => void emitLive(s, "assist:suggestion", { callId, id, status: "streaming", lines, tone: null, at: now }),
    );
    await emitLive(s, "assist:suggestion", out ? { callId, id, status: "done", lines: out.lines, tone: out.tone, at: now } : { callId, id, status: "failed", lines: [], tone: null, at: now });
  } finally {
    inflight.delete(callId);
  }
}

// ── Stopping ────────────────────────────────────────────────────────────────

async function finish(callId: string, why: "lead_ended" | "agent_left"): Promise<void> {
  const s = await load(callId);
  if (!s || s.done) return;
  const now = Date.now();
  const done: LiveState = { ...s, done: true, leadStoppedAt: now, agentSeconds: s.agentSeconds + (s.agentStartedAt ? Math.round((now - s.agentStartedAt) / 1000) : 0), agentStartedAt: null };
  await save(done);
  const p = pending.get(callId);
  if (p) clearTimeout(p.timer);
  pending.delete(callId);
  if (s.agentId && s.agentSid) {
    if ((await redis.get(AGENT_ON(s.agentId))) === callId) await redis.del(AGENT_ON(s.agentId));
    await setTranscribe(s.agentSid, "pause");
  }
  if (why === "agent_left") {
    // Nobody is watching the lead's words any more (a transfer): stop paying for them.
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { providerCallId: true } });
    if (call?.providerCallId) await setTranscribe(call.providerCallId, "pause");
  }
  await emitLive(done, "transcript:status", { callId, on: false, agentSide: false, message: null });
  await persistTranscript(callId);
  const leadSeconds = Math.round((now - s.leadStartedAt) / 1000);
  await prisma.call.update({ where: { id: callId }, data: { sttLeadSeconds: leadSeconds, sttAgentSeconds: done.agentSeconds } }).catch(() => undefined);
  void chargeTranscription({ callId, tenantId: s.tenantId, vendor: s.stt, leadSeconds, agentSeconds: done.agentSeconds, assistCalls: s.assistUsed }).catch((e) => log.warn({ err: e, callId }, "transcription charge failed"));
  if (s.summary || s.suggestDisposition) void afterCall(done).catch((e) => log.warn({ err: e, callId }, "post-call summary failed"));
}

/** The lead leg ended (status hook): transcription stops on both sides; summary and suggestion follow. */
export async function liveLeadEnded(callId: string): Promise<void> {
  await finish(callId, "lead_ended");
}

/** The agent left the call (external transfer, closer transfer): the agent's side stops, and the lead's too. */
export async function liveAgentLeft(callId: string): Promise<void> {
  await finish(callId, "agent_left");
}

// ── After the call ──────────────────────────────────────────────────────────

async function afterCall(s: LiveState): Promise<void> {
  const turns = await turnsOf(s.callId);
  if (turns.length < 2) return;
  const dispositions = s.suggestDisposition && s.campaignId ? await prisma.disposition.findMany({ where: { campaignId: s.campaignId, active: true }, orderBy: { sortOrder: "asc" }, select: { id: true, code: true, label: true } }) : [];
  const out = await summarizeCall({ tenantId: s.tenantId, callId: s.callId, model: s.model, campaign: s.campaignName, turns, dispositions: dispositions.length ? dispositions : null });
  if (!out) return;
  const pick = s.suggestDisposition ? pickSuggestedDisposition(dispositions, out.code) : null;
  const suggestion = pick ? { dispositionId: pick.id, code: pick.code, label: pick.label, reason: out.reason } : null;
  const call = await prisma.call.findUnique({ where: { id: s.callId }, select: { aiSummary: true, leadId: true, agentId: true } });
  if (!call) return;
  let notes: string | null = null;
  if (s.summary) {
    // Reuse the AI answer's field: an inbound call it handed over keeps that note first.
    const aiSummary = call.aiSummary ? `${call.aiSummary}\n\nCall: ${out.summary}` : out.summary;
    await prisma.call.update({ where: { id: s.callId }, data: { aiSummary, ...(suggestion ? { suggestedDisposition: suggestion } : {}) } });
    if (call.leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: call.leadId }, select: { notes: true } });
      notes = aiSummaryNote(lead?.notes, out.summary, new Date());
      await prisma.lead.update({ where: { id: call.leadId }, data: { notes } });
      await prisma.leadEvent.create({ data: { tenantId: s.tenantId, leadId: call.leadId, kind: "NOTE", data: { callId: s.callId, note: `AI summary: ${out.summary}`, source: "ai" } } }).catch(() => undefined);
    }
  } else if (suggestion) await prisma.call.update({ where: { id: s.callId }, data: { suggestedDisposition: suggestion } });
  const agentId = call.agentId ?? s.agentId;
  if (agentId) emitToAgent(agentId, "call:summary", { callId: s.callId, leadId: call.leadId, summary: s.summary ? out.summary : null, notes, suggestion });
}
