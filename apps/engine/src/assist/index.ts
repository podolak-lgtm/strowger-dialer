// Agent assist: what to say next. The campaign's rebuttal library answers the
// common objections; the AI suggestion uses the script, the rebuttals and the
// lead to propose three things to say for whatever the person just said.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { prisma } from "@strowger/db";
import * as z from "zod/v4";
import { config } from "../config";
import { log } from "../log";

const Suggestions = z.object({
  suggestions: z.array(z.object({ title: z.string(), say: z.string(), why: z.string() })).min(1).max(3),
  tone: z.string(),
});

let client: Anthropic | null = null;
export const assistConfigured = Boolean(config.ANTHROPIC_API_KEY);

export async function suggest(tenantId: string, campaignId: string, leadId: string | null, objection: string, goal: "sale" | "service" = "sale") {
  if (!assistConfigured) return { ok: false as const, error: "ANTHROPIC_API_KEY is not set on the engine" };
  const [campaign, lead, script] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: { name: true, rebuttals: true, tenant: { select: { name: true } } } }),
    leadId ? prisma.lead.findFirst({ where: { id: leadId, tenantId }, select: { firstName: true, city: true, state: true, leadType: true, attemptsTotal: true } }) : null,
    prisma.script.findFirst({ where: { campaignId }, orderBy: { version: "desc" }, select: { body: true } }),
  ]);
  if (!campaign) return { ok: false as const, error: "Unknown campaign" };
  const rebuttals = (campaign.rebuttals as { objection: string; response: string }[] | null) ?? [];
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
  const system = `You coach a phone agent at ${campaign.tenant.name}, live, mid-call, for the campaign "${campaign.name}". The goal is ${goal === "sale" ? "to keep the conversation going and move toward a sale without pressure or misleading claims" : "excellent customer service: resolve the issue, keep the customer"}. Give three short things the agent can say right now, in plain spoken English, each under 40 words, honest, no made-up facts, prices or guarantees. Prefer the campaign's own rebuttals when one fits; adapt wording to the lead. Add one line on why each works, and a one-word tone cue.`;
  const user = [
    script?.body ? `Campaign script:\n${script.body.slice(0, 3000)}` : null,
    rebuttals.length ? `Rebuttal library:\n${rebuttals.map((r) => `- "${r.objection}" → ${r.response}`).join("\n").slice(0, 3000)}` : null,
    lead ? `Lead: ${lead.firstName ?? "unknown first name"}, ${lead.city ?? ""} ${lead.state ?? ""}, type ${lead.leadType ?? "unknown"}, ${lead.attemptsTotal} prior attempts.` : null,
    `The person just said:\n"""${objection.slice(0, 600)}"""`,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const res = await client.messages.parse({ model: config.SMS_AI_MODEL, max_tokens: 1500, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }], output_config: { format: zodOutputFormat(Suggestions) } });
    if (!res.parsed_output) return { ok: false as const, error: "No suggestion came back" };
    return { ok: true as const, ...res.parsed_output };
  } catch (e) {
    log.warn({ err: e }, "assist suggest failed");
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
