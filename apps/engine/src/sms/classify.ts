// AI read of an inbound text reply. Keyword matching catches "STOP"; this
// catches "please don't call me again", "wrong number", "call me after 6",
// so opt-outs that a human would honour are honoured too (TCPA treats any
// reasonable expression of the wish as a revocation of consent).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { config } from "../config";
import { log } from "../log";
import { decideReplyAction, type ReplyAction, type ReplyRead } from "@strowger/shared/sms";

export const INTENTS = ["OPT_OUT", "CALLBACK_REQUEST", "QUESTION", "WRONG_NUMBER", "INTERESTED", "NOT_INTERESTED", "OTHER"] as const;
export type Intent = (typeof INTENTS)[number];

const Classification = z.object({
  intent: z.enum(INTENTS),
  /** 0–1. */
  confidence: z.number(),
  /** One short sentence, shown to supervisors. */
  reason: z.string(),
  /** For CALLBACK_REQUEST: the requested time as ISO 8601 in the lead's time zone, or null if none was given. */
  callback_at: z.string().nullable(),
});
export type Classification = z.infer<typeof Classification> & ReplyRead;

const SYSTEM = `You read text-message replies received by a call center and classify the sender's intent so the system can stay compliant.

Intents:
- OPT_OUT: the sender does not want further calls or texts, however they phrase it ("don't call me", "take me off your list", "leave me alone", "not interested, stop", "unsubscribe me", profanity telling us to go away, "wrong number, stop texting"). Revocation of consent in any reasonable words counts. Be generous: when a reply could reasonably be read as a request to stop, it is OPT_OUT.
- CALLBACK_REQUEST: the sender wants to be contacted, now or at a time they name ("call me", "try after 6", "tomorrow morning works").
- WRONG_NUMBER: the sender says this is not the person we wanted and does not ask for anything else.
- NOT_INTERESTED: declines the offer without asking us to stop contacting them ("no thanks").
- INTERESTED: positive, wants to proceed.
- QUESTION: asks something ("who is this?", "what is this about?").
- OTHER: anything else, including empty, automated or unrelated messages.

Return confidence from 0 to 1. For CALLBACK_REQUEST, convert any time they mention to an ISO 8601 datetime in the sender's time zone using the current local time given; null if no time is given. Keep the reason to one sentence.`;

let client: Anthropic | null = null;
export const smsAiConfigured = Boolean(config.ANTHROPIC_API_KEY);

export interface ClassifyInput {
  body: string;
  /** The last few texts in the thread, oldest first, for context. */
  thread?: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
  timezone?: string | null;
  leadFirstName?: string | null;
}

/** Null when not configured or the call fails: the caller falls back to keywords only. */
export async function classifyReply(input: ClassifyInput): Promise<Classification | null> {
  if (!smsAiConfigured) return null;
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
  const tz = input.timezone ?? "America/New_York";
  const nowLocal = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const history = (input.thread ?? []).map((m) => `${m.direction === "OUTBOUND" ? "Us" : "Them"}: ${m.body}`).join("\n");
  const user = [
    `Current local time for the sender: ${nowLocal} (${tz}).`,
    input.leadFirstName ? `The sender is on our list as ${input.leadFirstName}.` : null,
    history ? `Recent thread:\n${history}` : null,
    `Reply to classify:\n"""${input.body.slice(0, 1000)}"""`,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const res = await client.messages.parse({
      model: config.SMS_AI_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(Classification) },
    });
    const parsed = res.parsed_output;
    if (!parsed) {
      log.warn({ stop: res.stop_reason }, "sms classify: no parsed output");
      return null;
    }
    return { ...parsed, confidence: Math.max(0, Math.min(1, parsed.confidence)) };
  } catch (e) {
    log.error({ err: e }, "sms classify failed; keyword matching only for this reply");
    return null;
  }
}

/** What to do with a classification, at the configured opt-out threshold. */
export function decide(c: Classification | null): ReplyAction {
  return decideReplyAction(c, config.SMS_AI_OPT_OUT_THRESHOLD);
}
