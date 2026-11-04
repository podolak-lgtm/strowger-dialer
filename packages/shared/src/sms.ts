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
