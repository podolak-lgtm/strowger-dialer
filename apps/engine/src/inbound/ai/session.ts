// The AI answer's voice session: jambonz opens wss://<engine>/ws/ai when a
// call is moved here (control.ts) and runs the cascaded `agent` verb
// (speech-to-text → LLM → speech, with turn-taking and barge-in) for it.
//
// The @jambonz/sdk endpoint answers every plain HTTP request with 405 and
// destroys any upgrade it has no route for, so it must not sit on Fastify's
// server: it gets a detached http.Server of its own, and realtime.ts hands it
// only the upgrades for /ws/ai.
//
// Hand-off to people happens on: a hand-off phrase in the caller's transcript
// (checked on every user_transcript event, before the LLM's reply plays),
// the transfer_to_human tool, the agent verb ending for any reason but our
// own hangup tool or silence, the WebSocket dropping while the call is live,
// and the queue's aiMaxMinutes.
import http, { type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createEndpoint, type Session } from "@jambonz/sdk/websocket";
import { prisma } from "@strowger/db";
import { aiOpening, aiSystemPrompt, callerLocalLine, matchHandoffPhrase, AI_MAX_MINUTES_CAP, type AiMode } from "@strowger/shared/inbound";
import { resolveZone } from "@strowger/shared/geo";
import { config } from "../../config";
import { log } from "../../log";
import { redis } from "../../redis";
import { aiState, appendTurn, finishAi, handOff, patchAiState } from "./control";
import { AI_TOOLS, bookCallback, lookupCaller, takeMessage } from "./tools";

export const AI_WS_PATH = "/ws/ai";

const detached = http.createServer();
const makeService = createEndpoint({
  server: detached,
  logger: { info: (...a: unknown[]) => log.info({ sdk: a }, "jambonz ws"), error: (...a: unknown[]) => log.error({ sdk: a }, "jambonz ws"), debug: () => undefined },
});
const service = makeService({ path: AI_WS_PATH });
service.on("session:new", (session: Session) => {
  void runSession(session).catch((e) => {
    log.error({ err: e, callSid: session.callSid }, "AI session failed to start");
    void callIdFor(session).then((callId) => (callId ? handOff(callId, "the AI could not start") : undefined));
  });
});

/** realtime.ts: an upgrade for the AI session goes to the jambonz endpoint; true when it was ours. */
export function handleAiUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (!(req.url ?? "").startsWith(AI_WS_PATH)) return false;
  detached.emit("upgrade", req, socket, head);
  return true;
}

async function callIdFor(session: Session): Promise<string | null> {
  return session.callSid ? redis.get(`callsid:${session.callSid}`) : null;
}

type AgentEvent = { type?: string; transcript?: string; response?: string; greeting?: boolean };
type ToolCall = { tool_call_id: string; name: string; arguments?: Record<string, unknown> };

async function runSession(session: Session): Promise<void> {
  const callId = await callIdFor(session);
  const state = callId ? await aiState(callId) : null;
  const call = callId ? await prisma.call.findUnique({ where: { id: callId }, include: { queue: true, lead: true, tenant: { select: { name: true } } } }) : null;
  if (!callId || !state || !call?.queue) {
    log.warn({ callSid: session.callSid, callId }, "AI session for a call we are not handling");
    session.hangup().send();
    return;
  }
  const q = call.queue;
  const now = new Date();
  const zone = call.lead?.timezone ?? resolveZone({ zip: call.lead?.zip, state: call.lead?.state, phone: call.phone })?.timezone ?? null;
  const campaignId = q.campaignId ?? call.campaignId;
  const system = aiSystemPrompt({ business: call.tenant.name, queueName: q.name, mode: q.aiMode as AiMode, instructions: q.aiInstructions, knowledge: q.aiKnowledge, callerLocal: callerLocalLine(zone, now), canBookCallback: Boolean(campaignId) });
  const opening = aiOpening(q.aiGreeting, call.tenant.name);
  await patchAiState(callId, { systemChars: system.length });
  await appendTurn(callId, { role: "ai", text: opening, at: Date.now() });
  const phrases = q.aiHandoffPhrases.length ? q.aiHandoffPhrases : ["operator"];
  let over = false;
  const done = () => {
    over = true;
    clearTimeout(limit);
  };
  const toPeople = (reason: string) => {
    if (over) return;
    done();
    void handOff(callId, reason);
  };
  const limit = setTimeout(() => toPeople(`the ${q.aiMaxMinutes}-minute AI limit`), Math.min(AI_MAX_MINUTES_CAP, Math.max(1, q.aiMaxMinutes)) * 60_000);
  log.info({ callId, callSid: session.callSid, queueId: q.id, stt: state.stt, tts: state.tts, model: q.aiModel }, "AI session started");

  session
    .on("/ai-event", (evt: AgentEvent) => {
      if (over) return;
      if (evt.type === "user_transcript" && evt.transcript) {
        void appendTurn(callId, { role: "caller", text: evt.transcript, at: Date.now() });
        // Matched on the transcript itself, before the LLM, so "operator" always works and works at once.
        const hit = matchHandoffPhrase(evt.transcript, phrases);
        if (hit) toPeople(`the caller said "${hit}"`);
      } else if (evt.type === "agent_response" && evt.response) {
        void appendTurn(callId, { role: "ai", text: evt.response, at: Date.now() });
      }
    })
    .on("/ai-tool", (evt: ToolCall) => {
      void (async () => {
        const args = evt.arguments ?? {};
        let out: string;
        try {
          switch (evt.name) {
            case "transfer_to_human":
              session.sendToolOutput(evt.tool_call_id, "Transferring the caller now. Say nothing more.");
              toPeople(typeof args.reason === "string" && args.reason ? args.reason.slice(0, 200) : "the assistant could not help");
              return;
            case "lookup_caller":
              out = await lookupCaller(callId);
              break;
            case "book_callback":
              out = await bookCallback(callId, args);
              break;
            case "take_message":
              out = await takeMessage(callId, args);
              break;
            default:
              out = `Unknown tool ${evt.name}.`;
          }
        } catch (e) {
          log.warn({ err: e, callId, tool: evt.name }, "AI tool failed");
          out = "That did not work. Offer to take a message or transfer to a person.";
        }
        log.info({ callId, tool: evt.name }, "AI tool call");
        session.sendToolOutput(evt.tool_call_id, out);
      })();
    })
    .on("/ai-done", (evt: { completion_reason?: string; completionReason?: string }) => {
      const reason = String(evt?.completion_reason ?? evt?.completionReason ?? "unknown");
      log.info({ callId, reason }, "AI agent verb ended");
      if (over) return session.reply();
      if (/hang ?up/i.test(reason)) {
        // Our hangup tool: the conversation is over (the call is already being released).
        done();
        void finishAi(callId, "resolved");
        return session.reply();
      }
      if (/no.?response/i.test(reason)) {
        done();
        void finishAi(callId, "hangup", "no response");
        session.say({ text: "I haven't heard anything, so I'll end the call now. Please call back any time. Goodbye." }).hangup().reply();
        return;
      }
      // Anything else (an error, a vendor timeout): the people take over. A pause holds the line for the redirect.
      toPeople(`the AI stopped (${reason})`);
      session.pause({ length: 10 }).reply();
    })
    .on("close", () => {
      if (over) return;
      done();
      // The socket dropped: if the caller is still there, they go to people; if they hung up, the AI part is finished.
      setTimeout(() => {
        void prisma.call.findUnique({ where: { id: callId }, select: { endedAt: true } }).then(async (c) => {
          if (c?.endedAt) await finishAi(callId, "hangup");
          else await handOff(callId, "the AI connection dropped");
        });
      }, 1500);
    })
    .on("error", (err: Error) => log.warn({ err, callId }, "AI session socket error"));

  const inlineKey = q.aiLlmVendor === "anthropic" && config.AI_LLM_INLINE_KEY && config.ANTHROPIC_API_KEY ? { auth: { apiKey: config.ANTHROPIC_API_KEY } } : {};
  session
    .agent({
      stt: { vendor: state.stt ?? "deepgram", language: q.aiLanguage, hints: phrases },
      tts: { vendor: state.tts ?? config.TTS_VENDOR ?? "cartesia", language: q.aiLanguage, ...(q.aiVoice ? { voice: q.aiVoice } : config.TTS_VOICE && !q.aiTtsVendor ? { voice: config.TTS_VOICE } : {}) },
      llm: { vendor: q.aiLlmVendor, model: q.aiModel, ...inlineKey, llmOptions: { systemPrompt: system, maxTokens: 300, temperature: 0.4, tools: AI_TOOLS } },
      // A string greeting is spoken as is, without an LLM call (jambonz agent schema: boolean | string; the SDK's types still say boolean).
      greeting: opening as unknown as boolean,
      turnDetection: "krisp",
      bargeIn: { enable: true },
      hangup: { reason: "conversation complete" },
      noResponseTimeout: 10,
      noResponseMaxPrompts: 2,
      toolHook: "/ai-tool",
      eventHook: "/ai-event",
      actionHook: "/ai-done",
    })
    .send();
}
