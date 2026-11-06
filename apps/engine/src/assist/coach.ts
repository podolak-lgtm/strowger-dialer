// The Claude calls of live assist: the "Suggested next line" while the call is
// on (streamed into the agent's card), and the summary plus suggested
// disposition after it. Same client pattern as assist/index.ts and
// sms/classify.ts (structured output, usage recorded with recordAiUsage).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { partialLines, type TranscriptTurn } from "@strowger/shared/assist";
import * as z from "zod/v4";
import { recordAiUsage } from "../billing/vendor";
import { config } from "../config";
import { log } from "../log";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 1 }));
export const coachConfigured = () => Boolean(config.ANTHROPIC_API_KEY);

const NextLine = z.object({
  /** One or two short lines the agent can say next. */
  lines: z.array(z.string()).min(1).max(2),
  /** One word: calm, warm, confident, curious, empathetic, upbeat… */
  tone: z.string(),
});

export interface CoachContext {
  tenantId: string;
  callId: string;
  model: string;
  business: string;
  campaign: string;
  goal: "sale" | "service";
  script: string | null;
  rebuttals: Array<{ objection: string; response: string }>;
  bannedPhrases: string[];
  lead: { name: string | null; city: string | null; state: string | null; leadType: string | null; notes: string | null } | null;
  turns: TranscriptTurn[];
}

const RULES = (c: Pick<CoachContext, "business" | "campaign" | "goal" | "bannedPhrases">) =>
  [
    `You coach a phone agent at ${c.business}, live, during a call for the campaign "${c.campaign}". The customer just spoke.`,
    `Give the agent one or two short lines to say next (each under 30 words, plain spoken English) and a one-word tone cue.`,
    `The goal is ${c.goal === "sale" ? "to keep the conversation going honestly and move toward the next step of the script" : "excellent service: resolve the issue and keep the customer"}.`,
    "Never invent facts, prices, savings, dates, guarantees or promises; use only what the script, the rebuttal library or the customer said. If a fact is needed and you do not have it, have the agent offer to find out.",
    "Prefer the campaign's own rebuttal or script wording when it fits; adapt it to what the customer said. Never pressure, never argue, and if the customer asks to stop being called, the line is to confirm they will be taken off the list.",
    c.bannedPhrases.length ? `Never use these words or phrases: ${c.bannedPhrases.map((p) => `"${p}"`).join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");

function contextText(c: CoachContext): string {
  const lead = c.lead
    ? `Customer: ${c.lead.name ?? "name unknown"}${c.lead.city || c.lead.state ? `, ${[c.lead.city, c.lead.state].filter(Boolean).join(", ")}` : ""}${c.lead.leadType ? `, lead type ${c.lead.leadType}` : ""}.${c.lead.notes ? `\nNotes on file: ${c.lead.notes.slice(-800)}` : ""}`
    : "Customer: unknown caller.";
  const turns = c.turns.map((t) => `${t.speaker === "AGENT" ? "Agent" : "Customer"}: ${t.text}`).join("\n");
  return `${lead}\n\nThe conversation so far (most recent last):\n${turns}`;
}

function systemBlocks(c: CoachContext): Anthropic.TextBlockParam[] {
  // Stable per campaign: rules, script, rebuttals first (cacheable); the call's own text goes in the user turn.
  const library = [c.script ? `Campaign script:\n${c.script.slice(0, 4000)}` : null, c.rebuttals.length ? `Rebuttal library:\n${c.rebuttals.map((r) => `- "${r.objection}" → ${r.response}`).join("\n").slice(0, 4000)}` : null].filter(Boolean).join("\n\n");
  return [{ type: "text", text: `${RULES(c)}${library ? `\n\n${library}` : ""}`, cache_control: { type: "ephemeral" } }];
}

/**
 * One suggestion, streamed: `onPartial` gets the lines as they are written.
 * Null when it fails or the model declines (the card just stays empty).
 */
export async function suggestNextLine(c: CoachContext, onPartial: (lines: string[]) => void): Promise<{ lines: string[]; tone: string } | null> {
  if (!coachConfigured()) return null;
  try {
    const stream = anthropic().messages.stream({
      model: c.model,
      max_tokens: 400,
      system: systemBlocks(c),
      messages: [{ role: "user", content: contextText(c) }],
      output_config: { effort: "low", format: zodOutputFormat(NextLine) },
    });
    let text = "";
    let last = "";
    stream.on("text", (delta) => {
      text += delta;
      const lines = partialLines(text);
      const key = lines.join("\n");
      if (key && key !== last && key.length - last.length >= 12) {
        last = key;
        onPartial(lines);
      }
    });
    const res = await stream.finalMessage();
    void recordAiUsage(c.tenantId, "ai.live_assist", c.model, res.usage, c.callId);
    if (res.stop_reason === "refusal") return null;
    const parsed = res.parsed_output ?? null;
    if (!parsed) return null;
    return { lines: parsed.lines.map((l) => l.trim()).filter(Boolean).slice(0, 2), tone: parsed.tone.trim().split(/\s+/)[0] ?? "" };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e), callId: c.callId }, "live assist suggestion failed");
    return null;
  }
}

const AfterCall = z.object({
  /** Three to five sentences. */
  summary: z.string(),
  /** One of the codes listed, or null when none fits. */
  disposition_code: z.string().nullable(),
  /** One line: why that disposition. */
  reason: z.string(),
});

export interface AfterCallInput {
  tenantId: string;
  callId: string;
  model: string;
  campaign: string;
  turns: TranscriptTurn[];
  dispositions: Array<{ code: string; label: string }> | null;
}

/** The post-call summary (for the lead's notes) and, when asked, a suggested disposition from the campaign's list. */
export async function summarizeCall(i: AfterCallInput): Promise<{ summary: string; code: string | null; reason: string } | null> {
  if (!coachConfigured() || i.turns.length === 0) return null;
  const transcript = i.turns.map((t) => `${t.speaker === "AGENT" ? "Agent" : "Customer"}: ${t.text}`).join("\n").slice(-16_000);
  const system = [
    `You write the after-call note for a phone call on the campaign "${i.campaign}", from its live transcript (speech-to-text; expect small errors).`,
    "summary: three to five plain sentences on what the customer wanted or said, what the agent offered or agreed, and any follow-up (dates, times, documents). Only what the transcript says: no guesses, no advice, no markdown.",
    i.dispositions?.length
      ? `disposition_code: the code from this list that best fits how the call ended, or null when none clearly fits:\n${i.dispositions.map((d) => `- ${d.code}: ${d.label}`).join("\n")}\nreason: one short line saying why.`
      : "disposition_code: null. reason: an empty string.",
  ].join("\n");
  try {
    const res = await anthropic().messages.parse({
      model: i.model,
      max_tokens: 1200,
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: `Transcript:\n${transcript}` }],
      output_config: { effort: "low", format: zodOutputFormat(AfterCall) },
    });
    void recordAiUsage(i.tenantId, "ai.call_summary", i.model, res.usage, i.callId);
    if (res.stop_reason === "refusal" || !res.parsed_output) return null;
    const p = res.parsed_output;
    return { summary: p.summary.trim().slice(0, 1200), code: p.disposition_code, reason: p.reason.trim().slice(0, 300) };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e), callId: i.callId }, "post-call summary failed");
    return null;
  }
}
