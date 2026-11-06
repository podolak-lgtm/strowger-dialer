// Live transcription and agent assist: the rules that are not compliance
// (those are in compliance/live-call.ts). Pure: the engine (assist/live.ts)
// and the web app both use these.
import { words } from "./match";

export type Speaker = "CUSTOMER" | "AGENT";

export interface TranscriptTurn {
  speaker: Speaker;
  text: string;
  /** Epoch ms when the final result arrived. */
  at: number;
}

/** `Call.transcript` keeps at most this many finals, and this many characters in all; the oldest go first. */
export const TRANSCRIPT_MAX_TURNS = 400;
export const TRANSCRIPT_MAX_CHARS = 60_000;
/** One utterance longer than this is cut (an STT vendor that never finalises). */
export const TURN_MAX_CHARS = 2_000;

/** Append a final to the stored transcript, keeping it inside the caps (oldest turns dropped). */
export function appendTurn(list: readonly TranscriptTurn[] | null | undefined, turn: TranscriptTurn): TranscriptTurn[] {
  const text = turn.text.replace(/\s+/g, " ").trim().slice(0, TURN_MAX_CHARS);
  const out = [...(list ?? [])];
  if (!text) return out;
  out.push({ speaker: turn.speaker, text, at: turn.at });
  while (out.length > TRANSCRIPT_MAX_TURNS) out.shift();
  let chars = out.reduce((n, t) => n + t.text.length, 0);
  while (out.length > 1 && chars > TRANSCRIPT_MAX_CHARS) chars -= out.shift()!.text.length;
  return out;
}

/** Parse what is stored on `Call.transcript` (anything else is an empty transcript). */
export function readTranscript(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const r = t as Partial<TranscriptTurn>;
    return (r.speaker === "CUSTOMER" || r.speaker === "AGENT") && typeof r.text === "string" && typeof r.at === "number" ? [{ speaker: r.speaker, text: r.text, at: r.at }] : [];
  });
}

// ---- Live assist triggers

/** Wait this long after a CUSTOMER final for more of the same thought before acting. */
export const ASSIST_DEBOUNCE_MS = 1_200;
/** Fewer words than this ("yeah", "uh huh", "okay sure") never trigger assist. */
export const ASSIST_MIN_WORDS = 3;
export const DEFAULT_ASSIST_MODEL = "claude-haiku-5-5";
export const DEFAULT_ASSIST_MIN_GAP_SECONDS = 8;
export const DEFAULT_ASSIST_MAX_PER_CALL = 40;
/** The last turns sent to the model with each suggestion request. */
export const ASSIST_CONTEXT_TURNS = 12;

const FILLERS = new Set(["yeah", "yes", "yep", "no", "nope", "ok", "okay", "uh", "um", "huh", "hmm", "mhm", "mm", "right", "sure", "alright", "hello", "hi", "hey", "oh", "ah", "so", "well", "fine", "good", "thanks", "thank", "you", "bye", "uh-huh"]);

/** Too short, or nothing but fillers: not worth an assist. */
export function isFiller(text: string): boolean {
  const w = words(text);
  if (w.length < ASSIST_MIN_WORDS) return true;
  return w.every((x) => FILLERS.has(x));
}

export interface AssistBudget {
  /** Epoch ms of the last AI suggestion on this call, or null. */
  lastAt: number | null;
  /** AI suggestions already made on this call. */
  used: number;
}

export interface AssistLimits {
  minGapSeconds: number;
  maxPerCall: number;
}

/** May the AI be asked now? `reason` is why not (shown nowhere to the customer; logged). */
export function assistAllowed(b: AssistBudget, l: AssistLimits, now: number): { ok: true } | { ok: false; reason: "per_call_cap" | "too_soon" } {
  if (b.used >= Math.max(0, l.maxPerCall)) return { ok: false, reason: "per_call_cap" };
  if (b.lastAt !== null && now - b.lastAt < Math.max(0, l.minGapSeconds) * 1000) return { ok: false, reason: "too_soon" };
  return { ok: true };
}

/** Clamp the campaign's assist limits to sane ranges (form and engine). */
export function clampAssistLimits(minGapSeconds: number, maxPerCall: number): AssistLimits {
  return {
    minGapSeconds: Math.max(2, Math.min(120, Math.round(Number.isFinite(minGapSeconds) ? minGapSeconds : DEFAULT_ASSIST_MIN_GAP_SECONDS))),
    maxPerCall: Math.max(0, Math.min(200, Math.round(Number.isFinite(maxPerCall) ? maxPerCall : DEFAULT_ASSIST_MAX_PER_CALL))),
  };
}

/** Assist models offered on the campaign page (any `claude-*` id typed in is accepted too). */
export const ASSIST_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const;

export function assistModel(raw: string | null | undefined): string {
  const m = String(raw ?? "").trim();
  return /^claude-[a-z0-9.-]{3,60}$/.test(m) ? m : DEFAULT_ASSIST_MODEL;
}

// ---- Readiness: may transcription be switched on?

export interface SpeechCredLike {
  vendor: string;
  stt: boolean;
}

export interface TranscriptionReadiness {
  ok: boolean;
  problems: string[];
  /** The STT vendor transcription will use. */
  stt: string | null;
}

/** The exact jambonz step, in the words of the portal. */
export const STT_SETUP_STEP =
  'In jambonz: Account → Speech services → Add speech service → a speech-to-text vendor such as Deepgram (recommended for phone calls; Google, Microsoft or AssemblyAI also work), paste its API key and tick "Use for speech-to-text". Then save again.';

/**
 * Transcription needs jambonz configured and a speech-to-text vendor on the
 * account (`GET /v1/Accounts/{sid}/SpeechCredentials`, `use_for_stt`). The
 * engine's SCREENER_STT_VENDOR, when set, must be one of them; otherwise
 * Deepgram is preferred, then the first STT vendor.
 */
/**
 * Speech vendors that only speak (text-to-speech). A credential for one of
 * these can carry a "use for speech-to-text" tick in jambonz and still not
 * transcribe: on 6 Nov Cartesia was picked, jambonz raised "speech to text
 * credentials for cartesia have not been provisioned", and the calls lost
 * their audio and could not be hung up. Never pick these for transcription.
 */
export const TTS_ONLY_VENDORS: readonly string[] = ["cartesia", "elevenlabs", "playht", "rimelabs", "wellsaid", "whisper"];

export function transcriptionReadiness(i: { jambonzConfigured: boolean; creds: readonly SpeechCredLike[] | null; preferred?: string | null }): TranscriptionReadiness {
  const problems: string[] = [];
  if (!i.jambonzConfigured) problems.push("jambonz is not configured on the engine (JAMBONZ_API_KEY and JAMBONZ_ACCOUNT_SID).");
  let stt: string | null = null;
  if (i.creds === null) {
    if (i.jambonzConfigured) problems.push("Could not read the speech services on the jambonz account to check for speech-to-text; try again in a minute.");
  } else {
    const vendors = i.creds.filter((c) => c.stt && !TTS_ONLY_VENDORS.includes(c.vendor.toLowerCase())).map((c) => c.vendor);
    if (i.preferred) {
      if (vendors.includes(i.preferred)) stt = i.preferred;
      else problems.push(`The engine's speech-to-text vendor "${i.preferred}" (SCREENER_STT_VENDOR) is not on the jambonz account for speech-to-text${vendors.length ? ` (it has ${vendors.join(", ")})` : ""}. ${STT_SETUP_STEP}`);
    } else if (vendors.length) stt = vendors.includes("deepgram") ? "deepgram" : vendors[0]!;
    else problems.push(`The jambonz account has no speech-to-text vendor, so calls cannot be transcribed. ${STT_SETUP_STEP}`);
  }
  return { ok: problems.length === 0, problems, stt };
}

// ---- After the call

/** Lead notes get this marker before each AI summary. */
export const AI_SUMMARY_MARK = "AI summary";

/** The block appended to `Lead.notes`: a blank line, then "AI summary (6 Nov 2026, 14:05 UTC): …". */
export function aiSummaryNote(existing: string | null | undefined, summary: string, at: Date): string {
  const stamp = at.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }).replace(",", "");
  const block = `${AI_SUMMARY_MARK} (${stamp} UTC): ${summary.replace(/\s+/g, " ").trim()}`;
  const base = String(existing ?? "").trimEnd();
  return (base ? `${base}\n\n${block}` : block).slice(-20_000);
}

/** The AI summary blocks in a notes text, in order. */
export function aiSummaryBlocks(notes: string | null | undefined): string[] {
  return String(notes ?? "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`${AI_SUMMARY_MARK} (`));
}

/**
 * The console autosaves the notes box. When the engine appended an AI summary
 * after the box was loaded, a save from the box would drop it; keep any
 * summary block the stored notes have and the incoming text lacks.
 */
export function keepAiSummaries(stored: string | null | undefined, incoming: string | null | undefined): string {
  const inc = String(incoming ?? "");
  const missing = aiSummaryBlocks(stored).filter((b) => !inc.includes(b));
  if (missing.length === 0) return inc;
  const base = inc.trimEnd();
  return [base, ...missing].filter(Boolean).join("\n\n");
}

export interface DispositionChoice {
  id: string;
  code: string;
  label: string;
}

/** The model's suggested code, matched to one of the campaign's active dispositions (code first, then label), or null. */
export function pickSuggestedDisposition(choices: readonly DispositionChoice[], code: string | null | undefined): DispositionChoice | null {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return null;
  return choices.find((d) => d.code.toUpperCase() === c) ?? choices.find((d) => d.label.trim().toUpperCase() === c) ?? null;
}

// ---- Costs

/** Minutes by the second, to four places (the ledger's quantity). */
export function minutesOf(seconds: number): number {
  return Math.round((Math.max(0, seconds) / 60) * 10000) / 10000;
}

// ---- Streaming the suggestion

/**
 * The `lines` the model has written so far, from a partial JSON text such as
 * `{"lines":["Totally fair, most folks say tha` (the suggestion streams into
 * the card as it is written). Unfinished last string included.
 */
export function partialLines(json: string): string[] {
  const m = /"lines"\s*:\s*\[/.exec(json);
  if (!m) return [];
  const out: string[] = [];
  let i = m.index + m[0].length;
  while (i < json.length) {
    while (i < json.length && /[\s,]/.test(json[i]!)) i++;
    if (json[i] !== '"') break;
    i++;
    let s = "";
    let closed = false;
    while (i < json.length) {
      const c = json[i]!;
      if (c === "\\") {
        const n = json[i + 1];
        if (n === undefined) break;
        s += n === "n" ? " " : n === "t" ? " " : n === "u" ? "" : n;
        i += n === "u" ? 6 : 2;
        continue;
      }
      if (c === '"') {
        closed = true;
        i++;
        break;
      }
      s += c;
      i++;
    }
    if (s) out.push(s);
    if (!closed) break;
  }
  return out;
}
