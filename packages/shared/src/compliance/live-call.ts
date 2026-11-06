// Compliance rules checked against the live transcript (Live transcription
// and agent assist, HANDOFF). Data first: the rules, their default phrase
// lists and the wording the agent sees live here; the engine only calls
// these functions. A rule change comes with a test (live-call.test.ts).

export type LiveRuleId = "disclosure_missing" | "banned_phrase";

export interface LiveRule {
  id: LiveRuleId;
  title: string;
  severity: "critical" | "warning";
  /** What the agent's banner says. */
  agentMessage: string;
}

export const LIVE_CALL_RULES: Record<LiveRuleId, LiveRule> = {
  disclosure_missing: {
    id: "disclosure_missing",
    title: "Recording disclosure not given",
    severity: "critical",
    agentMessage: "Give the recording disclosure now",
  },
  banned_phrase: {
    id: "banned_phrase",
    title: "Banned phrase said",
    severity: "warning",
    agentMessage: "Don't promise that",
  },
};

/** Seconds after the lead joins the agent within which the agent must give the disclosure. */
export const DISCLOSURE_WINDOW_SECONDS = 30;

/** Heard in the agent's speech, any of these counts as the recording/transcription disclosure. */
export const DEFAULT_DISCLOSURE_PHRASES: readonly string[] = ["recorded", "recording", "quality and training", "monitored", "transcribed"];

/** Suggested banned phrases for a new campaign (the campaign page offers them; each campaign keeps its own list). */
export const DEFAULT_BANNED_PHRASES: readonly string[] = ["guaranteed", "free", "no cost", "risk-free"];

/** Ordinary speech that contains a banned word without making a claim ("feel free", "toll-free"). */
export const BANNED_PHRASE_EXCEPTIONS: readonly string[] = ["feel free", "toll free", "toll-free", "free to", "hands free", "hands-free", "free time", "free moment", "free minute", "are you free", "you free", "i'm free", "sugar free", "no guarantee", "not guaranteed", "can't guarantee", "cannot guarantee", "don't guarantee"];

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

/** Parse a phrase list as typed (one per line or comma separated), lowercased, de-duplicated, at most 50 of 60 chars. */
export function parsePhraseList(raw: string | readonly string[] | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\n,]/);
  const out: string[] = [];
  for (const p of parts) {
    const v = String(p).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 50);
}

/** Does the text contain the phrase as whole words? */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = norm(phrase).trim();
  return p.length > 0 && norm(text).includes(` ${p} `);
}

/** The disclosure phrases heard in this agent utterance (empty = not here). */
export function disclosureHeard(text: string, phrases: readonly string[] = DEFAULT_DISCLOSURE_PHRASES): string | null {
  return phrases.find((p) => hasPhrase(text, p)) ?? null;
}

/** Banned phrases the agent said, after removing the exceptions ("feel free" is not a free offer). */
export function findBannedPhrases(text: string, banned: readonly string[], exceptions: readonly string[] = BANNED_PHRASE_EXCEPTIONS): string[] {
  let t = norm(text);
  for (const e of exceptions) {
    const n = norm(e).trim();
    if (n) t = t.split(` ${n} `).join(" ~ ");
  }
  return banned.filter((p) => {
    const n = norm(p).trim();
    return n.length > 0 && t.includes(` ${n} `);
  });
}

export type DisclosureState = "not_required" | "given" | "pending" | "overdue" | "unknown";

/**
 * Where the disclosure stands on a call. `not_required` when the campaign does
 * not ask for a spoken disclosure, or plays a disclosure file to the lead
 * before the join (that file is the disclosure). `unknown` when the agent's
 * side is not being transcribed, so it cannot be heard: never an alert.
 */
export function disclosureState(i: { required: boolean; playedByFile: boolean; agentTranscribed: boolean; bridgedAt: number | null; heardAt: number | null; now: number; windowSeconds?: number }): DisclosureState {
  if (!i.required || i.playedByFile) return "not_required";
  if (i.heardAt !== null) return "given";
  if (!i.agentTranscribed || i.bridgedAt === null) return "unknown";
  return i.now - i.bridgedAt >= (i.windowSeconds ?? DISCLOSURE_WINDOW_SECONDS) * 1000 ? "overdue" : "pending";
}

export interface LiveAlert {
  rule: LiveRuleId;
  severity: LiveRule["severity"];
  message: string;
  /** For banned_phrase: what was said. */
  phrase?: string;
  text?: string;
  at: number;
}

export function bannedPhraseAlert(phrase: string, text: string, at: number): LiveAlert {
  const r = LIVE_CALL_RULES.banned_phrase;
  return { rule: r.id, severity: r.severity, message: `${r.agentMessage}: you said "${phrase}". No guarantees, free offers or claims the script does not make.`, phrase, text: text.slice(0, 300), at };
}

export function disclosureAlert(at: number): LiveAlert {
  const r = LIVE_CALL_RULES.disclosure_missing;
  return { rule: r.id, severity: r.severity, message: r.agentMessage, at };
}

/**
 * Two-party (all-party) consent states for recording a call, as commonly
 * listed; to be confirmed by counsel like the state rules. Shown on the
 * campaign page next to the spoken-disclosure switch.
 */
export const ALL_PARTY_CONSENT_STATES: readonly string[] = ["CA", "DE", "FL", "IL", "MD", "MA", "MI", "MT", "NV", "NH", "OR", "PA", "WA"];
