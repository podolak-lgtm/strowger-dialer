// Text-only Claude calls around the AI answer: the hand-off summary for the
// agent's screen pop, and the queue form's "Test the prompt" (one caller line
// in, the assistant's reply out, with the same fixed rules, instructions and
// tools the live call gets). The voice conversation itself runs inside
// jambonz's agent verb (session.ts).
import Anthropic from "@anthropic-ai/sdk";
import { aiOpening, aiSystemPrompt, callerLocalLine, matchHandoffPhrase, type AiMode } from "@strowger/shared/inbound";
import { recordAiUsage } from "../../billing/vendor";
import { config } from "../../config";
import { log } from "../../log";
import { AI_TOOLS } from "./tools";

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 }));

/** Two or three sentences for the agent who takes the caller: who, what they want, what the AI already did. */
export async function summarizeConversation(tenantId: string, turns: ReadonlyArray<{ role: "caller" | "ai"; text: string }>, callId?: string): Promise<string | null> {
  if (!config.ANTHROPIC_API_KEY || turns.length === 0) return null;
  const text = turns.map((t) => `${t.role === "caller" ? "Caller" : "Assistant"}: ${t.text}`).join("\n").slice(-12_000);
  try {
    const res = await anthropic().messages.create({
      model: config.AI_SUMMARY_MODEL,
      max_tokens: 200,
      system: "You write the hand-off note a phone agent reads in two seconds as a call connects. Two or three short sentences: what the caller wants, anything they gave (name, account, dates), and what the automated assistant already did or promised. No preamble, no markdown.",
      messages: [{ role: "user", content: `Conversation between a caller and the automated assistant:\n${text}` }],
    });
    void recordAiUsage(tenantId, "ai.summary", config.AI_SUMMARY_MODEL, res.usage, callId);
    const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
    return out ? out.slice(0, 600) : null;
  } catch (e) {
    log.warn({ err: e, callId }, "AI hand-off summary failed");
    return null;
  }
}

export interface PromptTestInput {
  tenantId: string;
  business: string;
  queueName: string;
  mode: AiMode;
  greeting: string | null;
  instructions: string | null;
  knowledge: string | null;
  handoffPhrases: string[];
  canBookCallback: boolean;
  model: string;
  line: string;
}

export type PromptTestResult = { ok: true; opening: string; reply: string; tools: Array<{ name: string; input: unknown }>; handoffPhrase: string | null } | { ok: false; error: string };

export async function testPrompt(i: PromptTestInput): Promise<PromptTestResult> {
  const opening = aiOpening(i.greeting, i.business);
  // The live call hands off on these words before the LLM sees them; the test says so.
  const phrase = matchHandoffPhrase(i.line, i.handoffPhrases);
  if (phrase) return { ok: true, opening, reply: "", tools: [{ name: "transfer_to_human", input: { reason: `the caller said "${phrase}"` } }], handoffPhrase: phrase };
  if (!config.ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY is not set on the engine." };
  const system = `${aiSystemPrompt({ business: i.business, queueName: i.queueName, mode: i.mode, instructions: i.instructions, knowledge: i.knowledge, callerLocal: callerLocalLine("America/New_York", new Date()), canBookCallback: i.canBookCallback })}\n\nYou opened the call by saying: "${opening}"`;
  // Only Anthropic models are tried here (the live call may use another vendor through jambonz).
  const model = i.model.startsWith("claude") ? i.model : config.AI_SUMMARY_MODEL;
  try {
    const res = await anthropic().messages.create({
      model,
      max_tokens: 300,
      system,
      tools: AI_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      messages: [{ role: "user", content: i.line.slice(0, 1000) }],
    });
    void recordAiUsage(i.tenantId, "ai.prompt_test", model, res.usage);
    const reply = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
    const tools = res.content.flatMap((b) => (b.type === "tool_use" ? [{ name: b.name, input: b.input }] : []));
    return { ok: true, opening, reply, tools, handoffPhrase: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
