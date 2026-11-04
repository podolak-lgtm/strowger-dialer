// The internal API the web app calls on behalf of a signed-in user. Every
// route is behind x-engine-key (see index.ts) and takes tenantId + userId
// from the body or query, which the web app has already authorised.
import { prisma } from "@strowger/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAgent, listAgents, patchAgent, removeAgent, setAgent } from "../agents/state";
import { dialLeadForAgent, dispositionCall, hangupCall } from "../dialer/calls";
import { onLeadPosted } from "../dialer/cadence";
import { crossbarConfigured } from "../scrub/crossbar";
import { scrubPendingForTenant } from "../scrub/job";
import { releaseLead, reserveNextLead } from "../dialer/hopper";
import { jambonz, jambonzConfigured } from "../jambonz/client";

const Ids = z.object({ tenantId: z.string(), userId: z.string() });

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/ping", async () => ({ pong: true, telephony: jambonzConfigured, scrub: crossbarConfigured }));

  app.post("/internal/scrub/run", async (req) => {
    const { tenantId } = z.object({ tenantId: z.string() }).parse(req.body);
    return scrubPendingForTenant(tenantId);
  });

  // ── Agent session ───────────────────────────────────────────────────────
  app.post("/internal/agents/login", async (req) => {
    const { tenantId, userId, campaignId } = Ids.extend({ campaignId: z.string() }).parse(req.body);
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
    if (!campaign) return { ok: false, error: "Unknown campaign" };
    const existing = await getAgent(userId);
    if (existing && existing.sessionId && existing.campaignId !== campaignId) {
      await prisma.agentSession.update({ where: { id: existing.sessionId }, data: { endedAt: new Date() } }).catch(() => undefined);
    }
    const session = await prisma.agentSession.create({ data: { tenantId, userId, campaignId, lastState: "LOGGED_IN", events: [{ state: "LOGGED_IN", at: new Date().toISOString() }] } });
    const live = await setAgent({
      tenantId,
      userId,
      campaignId,
      sessionId: session.id,
      state: existing?.agentCallSid ? "READY" : "LOGGED_IN",
      agentCallSid: existing?.agentCallSid ?? null,
      currentCallId: existing?.currentCallId ?? null,
      reservedLeadId: null,
      pauseReason: null,
      since: Date.now(),
    });
    return { ok: true, agent: live };
  });

  app.get("/internal/agents/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    return { agent: await getAgent(userId) };
  });

  app.post("/internal/agents/state", async (req) => {
    const { userId, state, reason } = Ids.extend({ state: z.enum(["READY", "PAUSED"]), reason: z.string().optional() }).parse(req.body);
    const live = await getAgent(userId);
    if (!live) return { ok: false, error: "Not logged in" };
    if (state === "READY" && !live.agentCallSid) return { ok: false, error: "Phone line is not up yet" };
    if (live.state === "ON_CALL") return { ok: false, error: "On a call" };
    const next = await patchAgent(userId, { state, pauseReason: state === "PAUSED" ? (reason ?? "Break") : null });
    return { ok: true, agent: next };
  });

  app.post("/internal/agents/logout", async (req) => {
    const { userId } = Ids.parse(req.body);
    const live = await getAgent(userId);
    if (live?.reservedLeadId) await releaseLead(live.reservedLeadId);
    if (live?.agentCallSid) await jambonz.calls.update(live.agentCallSid, { call_status: "completed" }).catch(() => undefined);
    await removeAgent(userId);
    return { ok: true };
  });

  app.get("/internal/floor", async (req) => {
    const { tenantId } = req.query as { tenantId: string };
    return { agents: await listAgents(tenantId) };
  });

  // ── Cadence trigger: lead.created ───────────────────────────────────────
  app.post("/internal/leads/posted", async (req) => {
    const { leadId } = z.object({ leadId: z.string() }).parse(req.body);
    // Run in the background: the poster already has its answer.
    onLeadPosted(leadId).catch((e) => app.log.warn({ err: e, leadId }, "onLeadPosted failed"));
    return { ok: true };
  });

  // ── Preview dialing ─────────────────────────────────────────────────────
  app.post("/internal/leads/next", async (req) => {
    const { tenantId, userId } = Ids.parse(req.body);
    const live = await getAgent(userId);
    if (!live?.campaignId) return { ok: false, error: "Not logged into a campaign" };
    if (live.reservedLeadId) {
      const lead = await prisma.lead.findUnique({ where: { id: live.reservedLeadId } });
      if (lead && lead.status === "DIALING") return { ok: true, lead };
    }
    const campaign = await prisma.campaign.findFirst({ where: { id: live.campaignId, tenantId } });
    if (!campaign) return { ok: false, error: "Campaign not found" };
    const r = await reserveNextLead(campaign, userId);
    if (!r.lead) return { ok: false, error: r.reason };
    await patchAgent(userId, { reservedLeadId: r.lead.id });
    return { ok: true, lead: r.lead, plan: r.plan };
  });

  app.post("/internal/leads/skip", async (req) => {
    const { userId, leadId } = Ids.extend({ leadId: z.string() }).parse(req.body);
    await releaseLead(leadId);
    await patchAgent(userId, { reservedLeadId: null });
    return { ok: true };
  });

  app.post("/internal/calls/dial", async (req) => {
    const { tenantId, userId, leadId } = Ids.extend({ leadId: z.string() }).parse(req.body);
    const live = await getAgent(userId);
    if (!live?.campaignId) return { ok: false, error: "Not logged into a campaign" };
    if (live.state !== "READY") return { ok: false, error: `Cannot dial while ${live.state.toLowerCase().replace("_", " ")}` };
    const [campaign, lead] = await Promise.all([
      prisma.campaign.findFirst({ where: { id: live.campaignId, tenantId } }),
      prisma.lead.findFirst({ where: { id: leadId, tenantId, ownerId: userId } }),
    ]);
    if (!campaign || !lead) return { ok: false, error: "Lead is no longer reserved for you" };
    return dialLeadForAgent(campaign, lead, userId);
  });

  app.post("/internal/calls/:callId/hangup", async (req) => {
    const { callId } = req.params as { callId: string };
    await hangupCall(callId);
    return { ok: true };
  });

  app.post("/internal/calls/:callId/disposition", async (req) => {
    const { callId } = req.params as { callId: string };
    const body = z
      .object({ userId: z.string(), dispositionId: z.string(), notes: z.string().nullable().optional(), callbackAt: z.string().nullable().optional(), callbackScope: z.enum(["AGENT", "CAMPAIGN"]).optional() })
      .parse(req.body);
    return dispositionCall({ callId, actorId: body.userId, dispositionId: body.dispositionId, notes: body.notes ?? null, callbackAt: body.callbackAt ?? null, callbackScope: body.callbackScope });
  });
}
