// Everything jambonz calls us about.
//
//   POST /jambonz/register   SIP registration of an agent softphone
//   POST /jambonz/call       a call reached our application (lead leg answered,
//                            or an agent's softphone dialled in)
//   POST /jambonz/amd        answering-machine events for a lead leg
//   POST /jambonz/status     call status lifecycle for every leg
//   POST /jambonz/conf       conference status events (join/leave)
//
// Replies are plain jambonz verb arrays. No TTS is used anywhere: every
// prompt is a `play` of an uploaded file, so the account needs no speech
// vendor to run.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@strowger/db";
import { decryptString, sipDigestMatches } from "@strowger/shared/secrets";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAgent, patchAgent } from "../agents/state";
import { redis } from "../redis";
import { config } from "../config";
import { callIdForSid, leadCallAnswered, leadCallBridged, leadCallEnded } from "../dialer/calls";
import { readyAgents, recordLedger } from "../dialer/pacing";
import { detectScreener } from "@strowger/shared/compliance";
import { emitToAgent } from "../realtime";
import type { Call, Campaign } from "@strowger/db";
import { log } from "../log";
import { agentRoom, hookUrl, jambonz } from "./client";

type Verb = Record<string, unknown>;

interface JambonzCallBody {
  call_sid: string;
  call_status?: string;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  caller_name?: string;
  sip_status?: number;
  duration?: number;
  customerData?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Verify Jambonz-Signature (t=…,v1=…) over `${t}.${rawBody}` when a secret is set. */
function signatureOk(req: FastifyRequest): boolean {
  const secret = config.JAMBONZ_WEBHOOK;
  if (!secret) return true;
  const header = req.headers["jambonz-signature"];
  if (!header || typeof header !== "string") return !config.JAMBONZ_REQUIRE_SIGNATURE;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function audioUrl(assetId: string | null | undefined): Promise<string | null> {
  if (!assetId) return null;
  const a = await prisma.audioAsset.findUnique({ where: { id: assetId } });
  return a?.storageUrl ?? null;
}

export async function registerJambonzRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw body for signature checks.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/jambonz/")) return;
    if (!signatureOk(req)) {
      log.warn({ url: req.url }, "jambonz webhook signature rejected");
      reply.code(401).send({ error: "bad signature" });
    }
  });

  // ── Registration ────────────────────────────────────────────────────────
  app.post("/jambonz/register", async (req, reply) => {
    const b = req.body as Record<string, string>;
    const username = b.username ?? "";
    const user = await prisma.user.findUnique({ where: { sipUsername: username }, include: { tenant: true } });
    if (!user || !user.active || !user.sipSecret) {
      log.info({ username }, "registration refused: unknown user");
      return reply.send({ status: "fail", message: "unknown user" });
    }
    const password = decryptString(user.sipSecret, config.ENGINE_INTERNAL_KEY);
    if (!password) return reply.send({ status: "fail", message: "credential error" });
    const ok = sipDigestMatches({
      username,
      realm: b.realm ?? config.JAMBONZ_SIP_REALM ?? "",
      password,
      method: b.method ?? "REGISTER",
      uri: b.uri ?? "",
      nonce: b.nonce ?? "",
      response: b.response ?? "",
      qop: b.qop,
      nc: b.nc,
      cnonce: b.cnonce,
      algorithm: b.algorithm,
    });
    if (!ok) {
      log.info({ username }, "registration refused: bad digest");
      return reply.send({ status: "fail", message: "bad credentials" });
    }
    const expires = Math.min(Number(b.expires) || 300, 300);
    return reply.send({
      status: "ok",
      expires,
      ...(config.JAMBONZ_APPLICATION_SID ? { application_sid: config.JAMBONZ_APPLICATION_SID } : {}),
    });
  });

  // ── Call reached the application ────────────────────────────────────────
  app.post("/jambonz/call", async (req, reply) => {
    const b = req.body as JambonzCallBody;
    const tag = (b.customerData ?? {}) as { kind?: string; callId?: string; agentId?: string };

    // Lead leg we created: it answered. Join the agent's room.
    const callId = tag.kind === "lead" ? tag.callId : await callIdForSid(b.call_sid);
    if (callId) return reply.send(await leadAnsweredVerbs(callId, b));

    // Otherwise an agent's softphone dialled in: that is their nailed-up leg.
    const sipUser = (b.from ?? "").replace(/^sip:/, "").split("@")[0] ?? "";
    const user = await prisma.user.findUnique({ where: { sipUsername: sipUser } });
    if (user) return reply.send(await agentLegVerbs(user.id, user.tenantId, b));

    log.warn({ from: b.from, to: b.to, sid: b.call_sid }, "call for nobody; hanging up");
    return reply.send([{ verb: "hangup" }]);
  });

  async function agentLegVerbs(userId: string, tenantId: string, b: JambonzCallBody): Promise<Verb[]> {
    const live = await getAgent(userId);
    if (!live) {
      log.info({ userId }, "agent softphone called in without a session");
      return [{ verb: "hangup" }];
    }
    await patchAgent(userId, { agentCallSid: b.call_sid, state: live.state === "PAUSED" ? "PAUSED" : "READY" });
    await redis.set(`agentsid:${b.call_sid}`, userId, "EX", 24 * 3600);
    return [
      {
        verb: "conference",
        name: agentRoom(userId),
        memberTag: "agent",
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        beep: false,
        statusHook: hookUrl("/jambonz/conf", { agentId: userId, tenantId }),
        statusEvents: ["start", "end", "join", "leave"],
      },
    ];
  }

  /** Conference-join verbs into an agent's room, with the optional disclosure first. */
  async function joinVerbs(call: Call, campaign: Campaign, agentId: string): Promise<Verb[]> {
    const verbs: Verb[] = [];
    if (campaign.disclosureOn) {
      const url = await audioUrl(campaign.disclosureAudioId);
      if (url) verbs.push({ verb: "play", url });
    }
    verbs.push({
      verb: "conference",
      name: agentRoom(agentId),
      memberTag: "lead",
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { callId: call.id, tenantId: call.tenantId }),
      statusEvents: ["join", "leave"],
      actionHook: hookUrl("/jambonz/conf-exit", { callId: call.id }),
    });
    verbs.push({ verb: "hangup" });
    return verbs;
  }

  async function abandonVerbs(call: Call, campaign: Campaign): Promise<Verb[]> {
    const safe = await audioUrl(campaign.safeHarborAudioId);
    await prisma.call.update({ where: { id: call.id }, data: { outcome: "ABANDONED", abandoned: true } });
    await recordLedger(campaign, "abandoned");
    log.warn({ callId: call.id, campaignId: campaign.id }, "abandoned call: no agent free");
    return [...(safe ? [{ verb: "play", url: safe }] : []), { verb: "hangup" }];
  }

  /**
   * A human is on an unreserved (ratio) call. Hand it to the longest-idle Ready
   * agent, or play the safe-harbor message and count the abandon.
   */
  async function bridgeToReadyAgent(call: Call, campaign: Campaign): Promise<Verb[]> {
    if (call.agentId) return joinVerbs(call, campaign, call.agentId);
    await recordLedger(campaign, "answered");
    const agent = (await readyAgents(campaign))[0];
    if (!agent) return abandonVerbs(call, campaign);
    const claimed = await prisma.call.updateMany({ where: { id: call.id, agentId: null }, data: { agentId: agent.userId } });
    if (claimed.count !== 1) return [{ verb: "hangup" }];
    await patchAgent(agent.userId, { state: "ON_CALL", currentCallId: call.id, reservedLeadId: null });
    if (call.leadId) await prisma.lead.update({ where: { id: call.leadId }, data: { ownerId: agent.userId } });
    emitToAgent(agent.userId, "call:update", { callId: call.id, status: "answered", leadId: call.leadId });
    return joinVerbs(call, campaign, agent.userId);
  }

  async function leadAnsweredVerbs(callId: string, b: JambonzCallBody): Promise<Verb[]> {
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } });
    if (!call || !call.campaign) return [{ verb: "hangup" }];
    await leadCallAnswered(callId);
    const campaign = call.campaign;

    // Screener detection: a background transcription of the first seconds.
    const screener: Verb[] =
      campaign.screenerDetection && config.SCREENER_STT_VENDOR
        ? [{ verb: "config", transcribe: { enable: true, transcriptionHook: hookUrl("/jambonz/transcript", { callId }), recognizer: { vendor: config.SCREENER_STT_VENDOR, language: config.SCREENER_STT_LANGUAGE, interim: false } } }]
        : [];

    if (call.agentId) {
      // Preview: the agent was reserved before the dial.
      const agent = await getAgent(call.agentId);
      if (!agent?.agentCallSid) return [...screener, ...(await abandonVerbs(call, campaign))];
      return [...screener, ...(await joinVerbs(call, campaign, call.agentId))];
    }

    // Ratio: with AMD on, hold the line until the AMD hook decides (it replies
    // with the bridge or the hangup). Without AMD, bridge now.
    if (campaign.amdEnabled) return [...screener, { verb: "pause", length: 8 }, { verb: "hangup" }];
    return [...screener, ...(await bridgeToReadyAgent(call, campaign))];
  }

  // ── Screener transcript + action ────────────────────────────────────────
  app.post("/jambonz/transcript", async (req, reply) => {
    const callId = (req.query as { callId?: string }).callId;
    const b = req.body as { speech?: { alternatives?: Array<{ transcript?: string }> } };
    const text = b.speech?.alternatives?.[0]?.transcript ?? "";
    if (!callId || !text) return reply.send({});
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } });
    if (!call?.campaign || call.bridgedAt || call.screenerDetected || call.endedAt) return reply.send({});
    if (call.answeredAt && Date.now() - call.answeredAt.getTime() > 12_000) return reply.send({});
    const m = detectScreener(text);
    if (!m.matched) return reply.send({});
    await prisma.call.update({ where: { id: callId }, data: { screenerDetected: true, amdResult: "SCREENER", providerData: { ...(call.providerData as object), screenerPhrase: m.phrase, screenerText: text } } });
    if (call.providerCallId) {
      await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/screener", { callId }), method: "POST" }).catch((e) => log.warn({ err: e, callId }, "screener redirect failed"));
    }
    return reply.send({});
  });

  app.post("/jambonz/screener", async (req, reply) => {
    const callId = (req.query as { callId?: string }).callId;
    const call = callId ? await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } }) : null;
    if (!call?.campaign) return reply.send([{ verb: "hangup" }]);
    const campaign = call.campaign;
    switch (campaign.screenerAction) {
      case "AGENT": {
        await prisma.call.update({ where: { id: call.id }, data: { outcome: "SCREENER_AGENT" } });
        return reply.send(await bridgeToReadyAgent(call, campaign));
      }
      case "MESSAGE": {
        const url = await audioUrl(campaign.screenerAudioId);
        await prisma.call.update({ where: { id: call.id }, data: { outcome: "SCREENER_MESSAGE" } });
        return reply.send([...(url ? [{ verb: "play", url }] : []), { verb: "hangup" }]);
      }
      default:
        await prisma.call.update({ where: { id: call.id }, data: { outcome: "SCREENER_HANGUP" } });
        return reply.send([{ verb: "hangup" }]);
    }
  });

  // ── AMD events on a lead leg ────────────────────────────────────────────
  app.post("/jambonz/amd", async (req, reply) => {
    const callId = (req.query as { callId?: string }).callId;
    const b = req.body as { type?: string; transcript?: string; reason?: string };
    if (!callId) return reply.send([]);
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } });
    if (!call?.campaign) return reply.send([]);
    const events = ((call.providerData as { amd?: unknown[] }).amd ?? []).concat([{ type: b.type, at: new Date().toISOString(), reason: b.reason ?? null }]);
    const patch: Record<string, unknown> = { providerData: { ...(call.providerData as object), amd: events } };

    switch (b.type) {
      case "amd_human_detected":
      case "amd_no_speech_detected":
      case "amd_decision_timeout": {
        if (b.type === "amd_human_detected") patch.amdResult = "HUMAN";
        else if (!call.amdResult) patch.amdResult = "UNKNOWN";
        await prisma.call.update({ where: { id: callId }, data: patch });
        // Ratio call parked on a pause: this reply replaces it with the bridge (or safe harbor).
        if (!call.agentId && !call.bridgedAt && !call.screenerDetected) return reply.send(await bridgeToReadyAgent({ ...call, ...patch } as Call, call.campaign));
        return reply.send([]);
      }
      case "amd_machine_detected": {
        patch.amdResult = "MACHINE";
        if (call.campaign.voicemailAction === "HANGUP") {
          patch.outcome = "VOICEMAIL";
          await prisma.call.update({ where: { id: callId }, data: patch });
          return reply.send([{ verb: "hangup" }]);
        }
        await prisma.call.update({ where: { id: callId }, data: patch });
        return reply.send([]); // wait for the beep
      }
      case "amd_tone_detected": {
        await prisma.call.update({ where: { id: callId }, data: patch });
        if (call.campaign.voicemailAction === "DROP" && call.amdResult === "MACHINE") {
          const url = await audioUrl(call.campaign.voicemailDropAudioId);
          await prisma.call.update({ where: { id: callId }, data: { outcome: url ? "VOICEMAIL_DROPPED" : "VOICEMAIL" } });
          return reply.send([...(url ? [{ verb: "play", url }] : []), { verb: "hangup" }]);
        }
        return reply.send([]);
      }
      default:
        await prisma.call.update({ where: { id: callId }, data: patch });
        return reply.send([]);
    }
  });

  // ── Conference status (join/leave) ──────────────────────────────────────
  app.post("/jambonz/conf", async (req, reply) => {
    const q = req.query as { callId?: string; agentId?: string; tenantId?: string };
    const b = req.body as { event?: string; members?: number };
    if (q.callId && b.event === "join") await leadCallBridged(q.callId);
    if (q.agentId && b.event === "end") {
      const live = await getAgent(q.agentId);
      if (live) await patchAgent(q.agentId, { agentCallSid: null, state: live.currentCallId ? "WRAP_UP" : "LOGGED_IN" });
    }
    return reply.send({});
  });

  app.post("/jambonz/conf-exit", async (_req, reply) => reply.send([{ verb: "hangup" }]));

  // ── Call status lifecycle ───────────────────────────────────────────────
  app.post("/jambonz/status", async (req, reply) => {
    const b = req.body as JambonzCallBody;
    const tag = (b.customerData ?? {}) as { kind?: string; callId?: string };
    const callId = tag.kind === "lead" ? tag.callId : await callIdForSid(b.call_sid);
    const status = b.call_status ?? "";
    if (callId) {
      if (status === "ringing" || status === "early-media") {
        await prisma.call.updateMany({ where: { id: callId, ringingAt: null }, data: { ringingAt: new Date() } });
      } else if (status === "in-progress") {
        await prisma.call.updateMany({ where: { id: callId, answeredAt: null }, data: { answeredAt: new Date() } });
      } else if (["completed", "failed", "busy", "no-answer"].includes(status)) {
        await leadCallEnded(callId, status, b.sip_status, b.duration);
      }
      return reply.send({});
    }
    // An agent leg ending.
    if (["completed", "failed", "busy", "no-answer"].includes(status)) {
      const userId = await redis.get(`agentsid:${b.call_sid}`);
      if (userId) {
        const live = await getAgent(userId);
        if (live && live.agentCallSid === b.call_sid) {
          await patchAgent(userId, { agentCallSid: null, state: live.currentCallId ? "WRAP_UP" : "LOGGED_IN" });
        }
        await redis.del(`agentsid:${b.call_sid}`);
      }
    }
    return reply.send({});
  });
}
