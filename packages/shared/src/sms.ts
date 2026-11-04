// Inbound text keywords. CTIA/TCPA opt-out words stop everything to that
// number; HELP gets the help reply; START re-enables.
export type SmsKeyword = "STOP" | "HELP" | "START" | null;

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "remove", "optout", "opt-out", "opt out", "no more"]);
const START_WORDS = new Set(["start", "unstop", "yes", "subscribe", "resume"]);
const HELP_WORDS = new Set(["help", "info"]);

export function smsKeyword(body: string | null | undefined): SmsKeyword {
  const t = (body ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, "");
  if (!t) return null;
  if (STOP_WORDS.has(t)) return "STOP";
  if (START_WORDS.has(t)) return "START";
  if (HELP_WORDS.has(t)) return "HELP";
  // "stop texting me", "please stop" etc.
  if (/^(please )?stop\b/.test(t) || /\bunsubscribe\b/.test(t)) return "STOP";
  return null;
}

export const DEFAULT_HELP_REPLY = "{{company}}: Reply STOP to opt out. Msg & data rates may apply.";
export const DEFAULT_STOP_REPLY = "{{company}}: You are unsubscribed and will receive no more messages.";

// --- AI read of free-text replies (the engine calls the model; the decision rules live here so they are testable).

export const REPLY_INTENTS = ["OPT_OUT", "CALLBACK_REQUEST", "QUESTION", "WRONG_NUMBER", "INTERESTED", "NOT_INTERESTED", "OTHER"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];
export interface ReplyRead {
  intent: ReplyIntent;
  /** 0–1 */
  confidence: number;
  callback_at: string | null;
}
export type ReplyAction = "opt_out" | "review" | "callback" | "none";

/** An opt-out at or above the threshold is applied; below it the lead is parked for a person to look. */
export function decideReplyAction(c: ReplyRead | null, optOutThreshold: number): ReplyAction {
  if (!c) return "none";
  if (c.intent === "OPT_OUT") return c.confidence >= optOutThreshold ? "opt_out" : "review";
  if (c.intent === "CALLBACK_REQUEST" && c.confidence >= 0.6) return "callback";
  return "none";
}

/** A callback time the model produced, or soon; never in the past or more than two weeks out. */
export function callbackDue(iso: string | null, now = new Date()): Date {
  const soon = new Date(now.getTime() + 15 * 60_000);
  if (!iso) return soon;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || t <= now) return soon;
  const max = now.getTime() + 14 * 86_400_000;
  return t.getTime() > max ? new Date(max) : t;
}
