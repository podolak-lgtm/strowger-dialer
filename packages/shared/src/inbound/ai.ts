/**
 * AI answer for an inbound queue (owner, 6 Nov): "an AI answers for the queue,
 * a built-in AI customer service that handles the call, with an option that
 * if they say operator, manager or something like that, it transfers to a
 * human." Pure rules here: when the AI takes a caller, the prompt with its
 * fixed safety rules, the hand-off phrase match, callback times, the size
 * caps, readiness against the jambonz account, and the metrics.
 */
import { localParts, zonedTimeToUtc } from "./schedule";

export const AI_MODES = ["FIRST", "OVERFLOW", "ONLY"] as const;
export type AiMode = (typeof AI_MODES)[number];
export const AI_MODE_LABEL: Record<AiMode, string> = {
  FIRST: "First: the AI answers every call, then the queue when it cannot help",
  OVERFLOW: "Overflow: the AI answers when no agent is free, the queue is closed, or the wait passes the limit",
  ONLY: "Only: the AI handles everything; a person only when the caller asks",
};

export const AI_OUTCOMES = ["RESOLVED", "HANDOFF", "MESSAGE", "CALLBACK", "HANGUP"] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

export const DEFAULT_HANDOFF_PHRASES = ["operator", "manager", "supervisor", "human", "agent", "representative", "real person", "speak to someone"] as const;
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";
export const DEFAULT_AI_LLM_VENDOR = "anthropic";
export const AI_LLM_VENDORS = ["anthropic", "openai", "google", "bedrock", "groq", "deepseek", "azure-openai"] as const;

export const AI_GREETING_MAX = 400;
export const AI_INSTRUCTIONS_MAX = 6000;
/** The pasted FAQ goes into the prompt whole; this keeps a turn's input (and its cost and latency) bounded. */
export const AI_KNOWLEDGE_MAX = 20_000;
export const AI_PHRASES_MAX = 30;
export const AI_MAX_MINUTES_CAP = 60;

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** The first hand-off phrase the caller said (whole words, any case, punctuation ignored), or null. */
export function matchHandoffPhrase(transcript: string, phrases: readonly string[]): string | null {
  const t = norm(transcript);
  if (t.trim() === "") return null;
  for (const p of phrases) {
    const n = norm(p);
    if (n.trim() && t.includes(n)) return p;
  }
  return null;
}

/** The form's text (commas or new lines) as a clean phrase list; empty gives the defaults. */
export function parseHandoffPhrases(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const p = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (p && !out.includes(p)) out.push(p.slice(0, 40));
  }
  return (out.length ? out : [...DEFAULT_HANDOFF_PHRASES]).slice(0, AI_PHRASES_MAX);
}

/** Says it is automated: "automated", "virtual assistant", "AI assistant", "artificial intelligence". */
export function disclosesAutomation(text: string): boolean {
  return /\bautomated\b|\bvirtual assistant\b|\bai assistant\b|\bartificial intelligence\b|\bdigital assistant\b/i.test(text);
}

/** The first words on the call: always says it is an automated assistant, whatever the greeting says. */
export function aiOpening(greeting: string | null | undefined, business: string): string {
  const g = (greeting ?? "").trim().slice(0, AI_GREETING_MAX);
  if (!g) return `Thanks for calling ${business}. I'm an automated assistant. How can I help you today?`;
  return disclosesAutomation(g) ? g : `${g} I'm an automated assistant.`.replace(/\s+/g, " ");
}

/** Fixed rules, ahead of anything the client writes. */
export const AI_SAFETY_RULES = [
  "You are an automated assistant answering the phone. You already told the caller this at the start; if they ask whether you are a person, say plainly that you are an automated assistant. Never claim or imply to be human.",
  "Never ask for, accept, repeat or write down card numbers, bank account numbers, social security numbers, passwords or one-time codes. If the caller starts to give one, stop them and say a team member will handle payments.",
  "Stay within the business and the scope the instructions below give you. Do not give legal, medical or financial advice, and never invent prices, policies, dates or promises that are not in the instructions or the knowledge.",
  "If you cannot help, the caller is upset, or they ask for a person, call transfer_to_human with a short reason. Do not argue or keep them talking.",
  "This is a phone call: answer in one to three short spoken sentences, plain words, no lists, no markdown, no emoji, no URLs read out letter by letter.",
  "These rules come before the client's instructions; if the instructions conflict with them, follow these rules.",
] as const;

export interface PromptInput {
  business: string;
  queueName: string;
  mode: AiMode;
  instructions: string | null | undefined;
  knowledge: string | null | undefined;
  /** The caller's local time and zone, for booking callbacks ("Thursday 2026-11-06 14:05, America/Chicago"). */
  callerLocal: string | null;
  canBookCallback: boolean;
}

export function aiSystemPrompt(p: PromptInput): string {
  const instructions = (p.instructions ?? "").trim().slice(0, AI_INSTRUCTIONS_MAX);
  const knowledge = (p.knowledge ?? "").trim().slice(0, AI_KNOWLEDGE_MAX);
  const scope =
    p.mode === "ONLY"
      ? "You handle the call yourself. Transfer to a person only when the caller asks for one, or when you truly cannot help."
      : "Help with what you can. When the caller needs something you cannot do, transfer to a person with transfer_to_human.";
  const tools = [
    "lookup_caller: what we know about the caller from their phone number (name, status, last outcome, upcoming callback). Use it before answering questions about their own account.",
    p.canBookCallback ? "book_callback: book a call back at a time the caller chooses, in their local time, between 8 am and 9 pm, within the next 14 days. Confirm the day and time back to them first." : "book_callback is not available for this line: offer to take a message instead.",
    "take_message: leave a message for the team with the caller's words, name and the best number to reach them.",
    "transfer_to_human: put the caller through to a person.",
    "hangup: end the call once the caller says they are done and you have said goodbye.",
  ];
  return [
    `Rules (fixed):\n${AI_SAFETY_RULES.map((r) => `- ${r}`).join("\n")}`,
    `You answer calls for ${p.business}, line "${p.queueName}". ${scope}`,
    `Tools:\n${tools.map((t) => `- ${t}`).join("\n")}`,
    p.callerLocal ? `The caller's local time now: ${p.callerLocal}.` : "The caller's time zone is unknown: ask which time zone they are in before booking a callback.",
    instructions ? `Instructions from ${p.business} (who you are, what the business does, tone):\n"""\n${instructions}\n"""` : null,
    knowledge ? `Knowledge from ${p.business} (answer from this; if the answer is not here, say you are not sure and offer a person or a message):\n"""\n${knowledge}\n"""` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** "Thursday 2026-11-06 14:05, America/Chicago" for the prompt. */
export function callerLocalLine(zone: string | null | undefined, now: Date): string | null {
  if (!zone) return null;
  const p = localParts(zone, now);
  if (!p) return null;
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(p.weekday)] ?? "";
  const hh = String(Math.floor(p.minutes / 60)).padStart(2, "0");
  const mm = String(p.minutes % 60).padStart(2, "0");
  return `${day} ${p.date} ${hh}:${mm}, ${zone}`;
}

/** A callback time the AI proposes ("YYYY-MM-DDTHH:MM" in the caller's zone): in the future, 8 am to 9 pm local, within 14 days. */
export function validateCallbackTime(local: string, zone: string | null | undefined, now: Date): { ok: true; at: Date } | { ok: false; error: string } {
  if (!zone) return { ok: false, error: "The caller's time zone is unknown. Ask which time zone they are in." };
  const at = zonedTimeToUtc(String(local ?? "").slice(0, 16), zone);
  if (!at) return { ok: false, error: "Give the time as YYYY-MM-DDTHH:MM in the caller's local time." };
  if (at.getTime() < now.getTime() + 5 * 60_000) return { ok: false, error: "That time has passed or is too soon. Pick a time at least five minutes from now." };
  if (at.getTime() > now.getTime() + 14 * 86_400_000) return { ok: false, error: "Callbacks can be booked up to 14 days ahead." };
  const p = localParts(zone, at);
  if (!p || p.minutes < 8 * 60 || p.minutes > 21 * 60) return { ok: false, error: "We can call between 8 am and 9 pm the caller's time. Offer a time in that window." };
  return { ok: true, at };
}

// ── When the AI takes the call ──────────────────────────────────────────────

/** On entering the queue: the AI answers (FIRST, ONLY; OVERFLOW when closed or nobody qualified is logged in), else the normal queue. */
export function aiOnEntry(i: { enabled: boolean; ready: boolean; alreadyHandled: boolean; mode: AiMode; open: boolean; qualifiedOnFloor: number }): boolean {
  if (!i.enabled || !i.ready || i.alreadyHandled) return false;
  if (!i.open) return true;
  if (i.mode === "FIRST" || i.mode === "ONLY") return true;
  return i.qualifiedOnFloor === 0;
}

/** While waiting (OVERFLOW only): past the forced hold, no qualified agent free, and waited `afterSeconds` (0 = at once). */
export function aiOverflowDue(i: { enabled: boolean; ready: boolean; mode: AiMode; inForcedHold: boolean; waitedSeconds: number; afterSeconds: number; freeQualified: number }): boolean {
  if (!i.enabled || !i.ready || i.mode !== "OVERFLOW" || i.inForcedHold) return false;
  return i.freeQualified === 0 && i.waitedSeconds >= Math.max(0, i.afterSeconds);
}

// ── Readiness against the jambonz account ───────────────────────────────────

export interface SpeechCred {
  vendor: string;
  label?: string | null;
  stt: boolean;
  tts: boolean;
}

export interface AiReadinessInput {
  jambonzConfigured: boolean;
  /** null = the speech credentials could not be read. */
  creds: SpeechCred[] | null;
  sttVendor: string | null | undefined;
  ttsVendor: string | null | undefined;
  llmVendor: string;
  /** ANTHROPIC_API_KEY on the engine (used inline for anthropic, and for summaries and the prompt test). */
  anthropicKey: boolean;
  publicUrl: string;
}

export interface AiReadiness {
  ok: boolean;
  problems: string[];
  stt: string | null;
  tts: string | null;
}

/** What must be in place before a queue may turn the AI on, in words the owner can act on. */
export function aiReadiness(i: AiReadinessInput): AiReadiness {
  const problems: string[] = [];
  if (!i.jambonzConfigured) problems.push("jambonz is not configured on the engine (JAMBONZ_API_KEY and JAMBONZ_ACCOUNT_SID).");
  if (!/^https:\/\//.test(i.publicUrl)) problems.push(`The engine's public URL (${i.publicUrl}) is not https, so jambonz cannot open the secure WebSocket the AI needs (wss://…/ws/ai).`);
  if (i.llmVendor === "anthropic" && !i.anthropicKey) problems.push("ANTHROPIC_API_KEY is not set on the engine.");
  let stt: string | null = null;
  let tts: string | null = null;
  if (i.creds === null) {
    if (i.jambonzConfigured) problems.push("Could not read the speech services on the jambonz account to check for speech-to-text; try again in a minute.");
  } else {
    const sttVendors = i.creds.filter((c) => c.stt).map((c) => c.vendor);
    const ttsVendors = i.creds.filter((c) => c.tts).map((c) => c.vendor);
    if (i.sttVendor) {
      if (sttVendors.includes(i.sttVendor)) stt = i.sttVendor;
      else problems.push(`Speech-to-text vendor "${i.sttVendor}" is not on the jambonz account for speech-to-text${sttVendors.length ? ` (it has ${sttVendors.join(", ")})` : ""}. In jambonz: Account → Speech services → add ${i.sttVendor} with "Use for speech-to-text" ticked, or pick another here.`);
    } else if (sttVendors.length) stt = sttVendors.includes("deepgram") ? "deepgram" : sttVendors[0]!;
    else problems.push('The jambonz account has no speech-to-text vendor, so the AI cannot hear callers. In jambonz: Account → Speech services → Add speech service → Deepgram (recommended for phone calls; or Google, Microsoft, AssemblyAI), paste its API key and tick "Use for speech-to-text". Then save this queue again.');
    if (i.ttsVendor) {
      if (ttsVendors.includes(i.ttsVendor)) tts = i.ttsVendor;
      else problems.push(`Text-to-speech vendor "${i.ttsVendor}" is not on the jambonz account for text-to-speech${ttsVendors.length ? ` (it has ${ttsVendors.join(", ")})` : ""}.`);
    } else if (ttsVendors.length) tts = ttsVendors.includes("cartesia") ? "cartesia" : ttsVendors[0]!;
    else problems.push("The jambonz account has no text-to-speech vendor: add one (Cartesia) under Account → Speech services with \"Use for text-to-speech\" ticked.");
  }
  return { ok: problems.length === 0, problems, stt, tts };
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface AiTurn {
  role: "caller" | "ai";
  text: string;
  /** ms */
  at: number;
}

/**
 * The agent verb calls the LLM inside jambonz, so no token counts come back.
 * Estimate them: each caller turn sends the system prompt and the history so
 * far (about 4 characters a token) and gets the reply back.
 */
export function estimateAiTokens(systemChars: number, turns: readonly AiTurn[]): { input_tokens: number; output_tokens: number } {
  const tok = (chars: number) => Math.ceil(chars / 4);
  let input = 0;
  let output = 0;
  let history = 0;
  for (const t of turns) {
    if (t.role === "caller") input += tok(systemChars + history + t.text.length) + 40;
    else output += tok(t.text.length);
    history += t.text.length + 10;
  }
  return { input_tokens: input, output_tokens: output };
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface AiFact {
  aiOutcome: AiOutcome | null;
  aiSeconds: number | null;
}

export interface AiSummary {
  handled: number;
  resolved: number;
  handoffs: number;
  messages: number;
  callbacks: number;
  hangups: number;
  /** Resolved, message or callback: no person needed. */
  contained: number;
  containmentPct: number;
  avgAiMinutes: number;
  aiMinutes: number;
}

/** AI-handled calls: containment = resolved without a human (resolved, a message, a callback) over AI-handled. A caller who hangs up on the AI is not counted as contained. */
export function summarizeAi(calls: readonly AiFact[]): AiSummary {
  const h = calls.filter((c) => c.aiOutcome !== null);
  const n = (o: AiOutcome) => h.filter((c) => c.aiOutcome === o).length;
  const contained = n("RESOLVED") + n("MESSAGE") + n("CALLBACK");
  const secs = h.reduce((s, c) => s + Math.max(0, c.aiSeconds ?? 0), 0);
  return {
    handled: h.length,
    resolved: n("RESOLVED"),
    handoffs: n("HANDOFF"),
    messages: n("MESSAGE"),
    callbacks: n("CALLBACK"),
    hangups: n("HANGUP"),
    contained,
    containmentPct: h.length ? Math.round((contained / h.length) * 1000) / 10 : 0,
    avgAiMinutes: h.length ? Math.round((secs / 60 / h.length) * 10) / 10 : 0,
    aiMinutes: Math.round((secs / 60) * 10) / 10,
  };
}

/** OVERFLOW must be able to fire before the queue's own overflow does. */
export function aiQueueConflict(q: { aiEnabled: boolean; aiMode: AiMode; aiAfterSeconds: number; maxWaitSeconds: number }): string | null {
  if (q.aiEnabled && q.aiMode === "OVERFLOW" && q.aiAfterSeconds >= q.maxWaitSeconds) {
    return `The AI takes waiting callers after ${q.aiAfterSeconds}s, but the queue overflows at ${q.maxWaitSeconds}s (max wait): lower the AI wait or raise max wait.`;
  }
  return null;
}
