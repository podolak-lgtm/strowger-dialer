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
import { log } from "../log";
import { agentRoom, hookUrl } from "./client";

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

  async function leadAnsweredVerbs(callId: string, b: JambonzCallBody): Promise<Verb[]> {
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaign: true } });
    if (!call || !call.campaign || !call.agentId) return [{ verb: "hangup" }];
    await leadCallAnswered(callId);
    const agent = await getAgent(call.agentId);
    if (!agent?.agentCallSid) {
      // Agent dropped between dial and answer. No safe-harbor needed in
      // preview (the agent was reserved), but never leave a person hanging.
      const safe = await audioUrl(call.campaign.safeHarborAudioId);
      await prisma.call.update({ where: { id: callId }, data: { outcome: "ABANDONED", abandoned: true } });
      return [...(safe ? [{ verb: "play", url: safe }] : []), { verb: "hangup" }];
    }
    const verbs: Verb[] = [];
    if (call.campaign.disclosureOn) {
      const url = await audioUrl(call.campaign.disclosureAudioId);
      if (url) verbs.push({ verb: "play", url });
    }
    verbs.push({
      verb: "conference",
      name: agentRoom(call.agentId),
      memberTag: "lead",
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { callId, tenantId: call.tenantId }),
      statusEvents: ["join", "leave"],
      actionHook: hookUrl("/jambonz/conf-exit", { callId }),
    });
    verbs.push({ verb: "hangup" });
    return verbs;
  }

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
        patch.amdResult = "HUMAN";
        await prisma.call.update({ where: { id: callId }, data: patch });
        return reply.send([]);
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
