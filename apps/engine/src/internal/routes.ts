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
import { getSupervision, setSupervisionMode, startSupervision, stopSupervision, takeOver } from "../supervise";
import { handleInboundText } from "../sms/inbound";
import { sendSms } from "../sms/provider";
import { deliverPending } from "../webhooks/deliver";
import { agentVoicemailDrop } from "../dialer/voicemail";
import { holdCall, manualDial, transferCall, transferTargets } from "../dialer/controls";
import { agentLeaveTransfer, cancelTransfer, liveTransfer, startExternalTransfer, transferredCalls, transferView } from "../dialer/transfers";
import { nightlyRecordings } from "../recordings/export";
import { releaseLead, reserveNextLead } from "../dialer/hopper";
import { jambonz, jambonzConfigured } from "../jambonz/client";
import { assignNumbersToCampaign, createBrand, createTenDlcCampaign, orderNumbers, provisionStatus, releaseNumber, searchNumbers, setupCarrier, syncNumbers, tenDlcStatus, usecaseFees } from "../provision";
import type { BrandInput, CampaignInput } from "../provision/telnyx";
import { fcrProgress, startFcrRun } from "../provision/fcr";
import { applyDidPlan, loadDidPlan } from "../provision/plan";
import { chatHistory, sendChat } from "../chat";
import { acceptWager, announceCampaignBets, declineWager, endPokerRun, gamesOverview, proposeWager, setCampaignBets, startPokerRun, withdrawWager } from "../games";
import { suggest } from "../assist";
import { billingOverview, billingStatus, chargeSeatIfNew, outboundAllowed, platformOverview, rates, recordPayment, trialSeatRefusal } from "../billing";
import { changeAttribution, endReferral, referralsForTenant, referralsPlatform, runReferralCredits, saveReferralSettings, setReferrerOverride, signup, signupOffer } from "../referrals";
import { log } from "../log";
import { syncTelnyxCosts, vendorSpend } from "../billing/vendor";
import { createWorkspace, moveCampaign } from "../workspaces";
import { parsePokerRule, type WagerKind } from "@strowger/shared/games";

const Ids = z.object({ tenantId: z.string(), userId: z.string() });

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/ping", async () => ({ pong: true, telephony: jambonzConfigured, scrub: crossbarConfigured }));

  /** Proves the jambonz key works: a cheap authenticated read. */
  app.get("/internal/jambonz/check", async () => {
    if (!jambonzConfigured) return { ok: false, error: "not configured" };
    try {
      const count = await jambonz.calls.count();
      return { ok: true, activeCalls: count };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post("/internal/scrub/run", async (req) => {
    const { tenantId } = z.object({ tenantId: z.string() }).parse(req.body);
    return scrubPendingForTenant(tenantId);
  });

  // ── Agent session ───────────────────────────────────────────────────────
  app.post("/internal/agents/login", async (req) => {
    const { tenantId, userId, campaignId } = Ids.extend({ campaignId: z.string() }).parse(req.body);
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
    if (!campaign) return { ok: false, error: "Unknown campaign" };
    const allowed = await outboundAllowed(tenantId);
    if (!allowed.ok) return { ok: false, error: allowed.error };
    const seatRefused = await trialSeatRefusal(tenantId, userId);
    if (seatRefused) return { ok: false, error: seatRefused };
    await chargeSeatIfNew(tenantId, userId).catch((e) => log.warn({ err: e }, "billing: seat charge failed"));
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
      // Owner, 6 Nov: an agent logs in paused and goes Ready on purpose; nothing dials for them before that.
      // A re-login mid-call keeps the call's state.
      state: existing?.currentCallId && (existing.state === "ON_CALL" || existing.state === "WRAP_UP") ? existing.state : "PAUSED",
      agentCallSid: existing?.agentCallSid ?? null,
      currentCallId: existing?.currentCallId ?? null,
      reservedLeadId: null,
      pauseReason: existing?.currentCallId ? (existing.pauseReason ?? null) : "Not ready yet",
      readyOnLine: false,
      afterCall: existing?.currentCallId ? (existing.afterCall ?? null) : null,
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
    if (live.state === "ON_CALL") return { ok: false, error: "On a call" };
    // Ready with no line yet: stay as you are and go Ready the moment the line joins (the console raises it next).
    if (state === "READY" && !live.agentCallSid) {
      const next = await patchAgent(userId, { readyOnLine: true });
      return { ok: true, agent: next };
    }
    const next = await patchAgent(userId, { state, pauseReason: state === "PAUSED" ? (reason ?? "Break") : null, readyOnLine: false });
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

  // ── Supervision ─────────────────────────────────────────────────────────
  app.post("/internal/supervise/start", async (req) => {
    const { tenantId, userId, agentId, mode } = Ids.extend({ agentId: z.string(), mode: z.enum(["LISTEN", "WHISPER", "BARGE"]) }).parse(req.body);
    return startSupervision(tenantId, userId, agentId, mode);
  });
  app.post("/internal/supervise/mode", async (req) => {
    const { userId, mode } = Ids.extend({ mode: z.enum(["LISTEN", "WHISPER", "BARGE"]) }).parse(req.body);
    return setSupervisionMode(userId, mode);
  });
  app.post("/internal/supervise/takeover", async (req) => {
    const { userId } = Ids.parse(req.body);
    return takeOver(userId);
  });
  app.post("/internal/supervise/stop", async (req) => {
    const { userId } = Ids.parse(req.body);
    await stopSupervision(userId);
    return { ok: true };
  });
  app.get("/internal/supervise/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    return { supervision: await getSupervision(userId) };
  });

  // ── Texting ─────────────────────────────────────────────────────────────
  app.post("/internal/sms/inbound", async (req) => {
    const b = z.object({ provider: z.string(), providerMessageId: z.string().nullable(), from: z.string(), to: z.string(), body: z.string(), raw: z.unknown().optional() }).parse(req.body);
    return handleInboundText(b);
  });
  app.post("/internal/sms/send", async (req) => {
    const b = Ids.extend({ leadId: z.string(), body: z.string().min(1).max(1000) }).parse(req.body);
    const lead = await prisma.lead.findFirst({ where: { id: b.leadId, tenantId: b.tenantId }, include: { list: { select: { campaignId: true } } } });
    if (!lead) return { ok: false, error: "Unknown lead" };
    if (lead.status === "DNC" || lead.status === "BLOCKED") return { ok: false, error: "This number has opted out or is blocked" };
    const dnc = await prisma.dncEntry.findFirst({ where: { tenantId: b.tenantId, phone: lead.phone, scope: "SYSTEM" } });
    if (dnc) return { ok: false, error: "This number is on the do-not-call list" };
    let from = lead.assignedCallerId;
    if (from) {
      const n = await prisma.callerIdNumber.findFirst({ where: { tenantId: b.tenantId, phone: from, smsEnabled: true, status: "ACTIVE" } });
      if (!n) from = null;
    }
    if (!from) from = (await prisma.callerIdNumber.findFirst({ where: { tenantId: b.tenantId, smsEnabled: true, status: "ACTIVE", areaCode: lead.phone.slice(0, 3) } }))?.phone ?? (await prisma.callerIdNumber.findFirst({ where: { tenantId: b.tenantId, smsEnabled: true, status: "ACTIVE" } }))?.phone ?? null;
    if (!from) return { ok: false, error: "No SMS-enabled number in the pool" };
    const r = await sendSms({ tenantId: b.tenantId, campaignId: lead.list.campaignId, leadId: lead.id, agentId: b.userId, from, to: lead.phone, body: b.body, purpose: null });
    if (r.ok) await prisma.lead.update({ where: { id: lead.id }, data: { ...(lead.assignedCallerId ? {} : { assignedCallerId: from }), lastAgentId: b.userId } });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Send failed" };
  });

  app.post("/internal/webhooks/deliver", async () => deliverPending());

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

  app.post("/internal/calls/:callId/hold", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId, hold } = z.object({ userId: z.string(), hold: z.boolean() }).parse(req.body);
    return holdCall(callId, userId, hold);
  });
  app.get("/internal/transfer-targets", async (req) => {
    const { tenantId, userId, campaignId } = req.query as { tenantId: string; userId: string; campaignId?: string };
    return { targets: await transferTargets(tenantId, campaignId || null, userId) };
  });
  app.post("/internal/calls/:callId/transfer", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId, toAgentId } = z.object({ userId: z.string(), toAgentId: z.string() }).parse(req.body);
    return transferCall(callId, userId, toAgentId);
  });
  // External transfers (dialer/transfers.ts): destinations are campaign data the web app reads itself.
  app.post("/internal/calls/:callId/transfer-external", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId, destinationId, mode } = z.object({ userId: z.string(), destinationId: z.string(), mode: z.enum(["COLD", "WARM"]) }).parse(req.body);
    return startExternalTransfer(callId, userId, destinationId, mode);
  });
  app.post("/internal/calls/:callId/transfer-leave", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    return agentLeaveTransfer(callId, userId, "leave");
  });
  app.post("/internal/calls/:callId/transfer-cancel", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    return cancelTransfer(callId, userId);
  });
  app.get("/internal/calls/:callId/transfer", async (req) => {
    const { callId } = req.params as { callId: string };
    const t = await liveTransfer(callId);
    return { transfer: t ? transferView(t, t.agentLeftAt ? "left" : t.answeredAt ? "answered" : "ringing") : null };
  });
  app.get("/internal/transferred", async (req) => {
    const { tenantId } = z.object({ tenantId: z.string() }).parse(req.query);
    return { calls: await transferredCalls(tenantId) };
  });
  app.post("/internal/calls/manual", async (req) => {
    const { tenantId, userId, phone } = Ids.extend({ phone: z.string() }).parse(req.body);
    return manualDial(tenantId, userId, phone);
  });

  app.post("/internal/calls/:callId/voicemail", async (req) => {
    const { callId } = req.params as { callId: string };
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    return agentVoicemailDrop(callId, userId);
  });

  app.post("/internal/recordings/run", async () => {
    await nightlyRecordings();
    return { ok: true };
  });

  app.post("/internal/calls/:callId/disposition", async (req) => {
    const { callId } = req.params as { callId: string };
    const body = z
      .object({ userId: z.string(), dispositionId: z.string().optional(), notes: z.string().nullable().optional(), callbackAt: z.string().nullable().optional(), callbackScope: z.enum(["AGENT", "CAMPAIGN"]).optional() })
      .parse(req.body);
    // No dispositionId = a callback: the campaign's callback disposition, created if missing.
    return dispositionCall({ callId, actorId: body.userId, dispositionId: body.dispositionId ?? null, notes: body.notes ?? null, callbackAt: body.callbackAt ?? null, callbackScope: body.callbackScope });
  });

  // ---- Provisioning (numbers at Telnyx + jambonz, 10DLC). Errors come back as 400 with the carrier's message.
  const wrap = async <T,>(fn: () => Promise<T>, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return reply.code(400).send({ error: message });
    }
  };
  // ---- Billing
  app.get("/internal/billing/status", async (req) => billingStatus(z.object({ tenantId: z.string() }).parse(req.query).tenantId));
  app.get("/internal/billing/overview", async (req) => {
    const q = z.object({ tenantId: z.string(), period: z.string().optional() }).parse(req.query);
    return billingOverview(q.tenantId, q.period);
  });
  app.get("/internal/billing/platform", async (req) => platformOverview(z.object({ period: z.string().optional() }).parse(req.query).period));
  app.post("/internal/billing/payment", async (req, reply) => {
    const b = z.object({ tenantId: z.string(), amountCents: z.number().int(), note: z.string().max(200), createdById: z.string() }).parse(req.body);
    try {
      await recordPayment(b.tenantId, b.amountCents, b.note, b.createdById);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/internal/billing/plan", async (req) => {
    const b = z.object({ tenantId: z.string(), seatMonthlyCents: z.number().int().min(0), perMinuteMillicents: z.number().int().min(0), didMarkupPct: z.number().int().min(0), scrubMarginMillicents: z.number().int().min(0), smsPriceMillicents: z.number().int().min(0), lowBalanceCents: z.number().int().min(0), graceDays: z.number().int().min(0).max(60) }).parse(req.body);
    const { tenantId, ...plan } = b;
    await prisma.billingAccount.upsert({ where: { tenantId }, create: { tenantId, ...plan }, update: plan });
    return { ok: true };
  });
  app.post("/internal/billing/rates", async (req) => {
    const b = z.object({ telnyxOutMillicentsPerMin: z.number().int().min(0), telnyxInMillicentsPerMin: z.number().int().min(0), didMonthlyCents: z.number().int().min(0), scrubCostMillicents: z.number().int().min(0), smsCostMillicents: z.number().int().min(0), prepayInstructions: z.string().max(2000).nullable() }).parse(req.body);
    await rates();
    await prisma.platformRates.update({ where: { id: "default" }, data: b });
    return { ok: true };
  });

  // ---- Referral program and free trial (owner, 6 Nov)
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
  app.get("/internal/referrals", async (req) => referralsForTenant(z.object({ tenantId: z.string() }).parse(req.query).tenantId));
  app.get("/internal/referrals/platform", async () => referralsPlatform());
  app.post("/internal/referrals/run", async (req, reply) => {
    const b = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), userId: z.string() }).parse(req.body);
    try {
      return { ok: true, ...(await runReferralCredits(b.period, b.userId)) };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/internal/referrals/settings", async (req) => {
    const b = z.object({ referralPct: z.number().min(0).max(50), trialDays: z.number().int().min(1).max(60), trialSeats: z.number().int().min(1).max(100), trialAllowanceCents: z.number().int().min(0).max(1_000_000), trialMaxNumbers: z.number().int().min(0).max(100), trialWithoutReferral: z.boolean() }).parse(req.body);
    await saveReferralSettings(b);
    return { ok: true };
  });
  app.post("/internal/referrals/override", async (req) => {
    const b = z.object({ tenantId: z.string(), pct: z.number().min(0).max(50).nullable() }).parse(req.body);
    await setReferrerOverride(b.tenantId, b.pct);
    return { ok: true };
  });
  app.post("/internal/referrals/attribution", async (req, reply) => {
    const b = z.object({ referralId: z.string(), referrerTenantId: z.string() }).parse(req.body);
    try {
      return { ok: true, ...(await changeAttribution(b.referralId, b.referrerTenantId)) };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/internal/referrals/end", async (req) => {
    const b = z.object({ referralId: z.string(), reason: z.string().max(200) }).parse(req.body);
    const r = await endReferral(b.referralId, b.reason);
    return { ok: true, referrerTenantId: r.tenantId, referredTenantId: r.referredTenantId };
  });
  app.get("/internal/signup/offer", async (req) => {
    const q = z.object({ email: z.string(), ref: z.string().optional(), clerkUserId: z.string().optional(), phone: z.string().optional() }).parse(req.query);
    return signupOffer(q.email, q.ref ?? null, q.clerkUserId ?? null, q.phone ?? null);
  });
  app.post("/internal/signup", async (req) => {
    const b = z.object({ clerkUserId: z.string(), email: z.string().email(), firstName: z.string().nullable(), lastName: z.string().nullable(), companyName: z.string().max(80), businessPhone: z.string().max(30).nullable(), refCode: z.string().max(20).nullable(), acceptTrialTerms: z.boolean(), acceptUsageTerms: z.boolean(), withoutTrial: z.boolean() }).parse(req.body);
    return signup(b);
  });

  // ---- Vendor costs (what we pay) and workspaces
  app.get("/internal/billing/vendor", async (req) => vendorSpend(z.object({ period: z.string().optional() }).parse(req.query).period));
  app.post("/internal/billing/vendor/sync", async (req, reply) => {
    const b = z.object({ dateRange: z.string().optional() }).parse(req.body ?? {});
    try {
      return { ok: true, ...(await syncTelnyxCosts(b.dateRange ?? "last_3_days")) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/internal/workspaces", async (req, reply) => {
    const b = z.object({ name: z.string().min(2).max(80), adminEmail: z.string().email().nullable() }).parse(req.body);
    try {
      return { ok: true, ...(await createWorkspace(b.name, b.adminEmail)) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/internal/workspaces/move-campaign", async (req, reply) => {
    const b = z.object({ campaignId: z.string(), fromTenantId: z.string(), toTenantId: z.string() }).parse(req.body);
    try {
      return { ok: true, report: await moveCampaign(b.campaignId, b.fromTenantId, b.toTenantId) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- Games
  app.get("/internal/games", async (req) => {
    const q = z.object({ tenantId: z.string(), userId: z.string(), scope: z.enum(["mine", "all"]).optional(), campaignId: z.string().optional() }).parse(req.query);
    return gamesOverview(q.tenantId, q.userId, q.scope ?? "mine", q.campaignId || null);
  });
  app.post("/internal/games/wager", async (req, reply) => {
    const b = Ids.extend({ action: z.enum(["propose", "accept", "decline", "withdraw"]), wagerId: z.string().optional(), campaignId: z.string().optional(), accepterId: z.string().nullable().optional(), kind: z.string().optional(), stake: z.number().int().optional(), note: z.string().optional() }).parse(req.body);
    try {
      if (b.action === "propose") return { ok: true, wager: await proposeWager(b.tenantId, b.userId, b.campaignId ?? "", b.accepterId ?? null, b.kind as WagerKind, b.stake ?? 0, b.note) };
      if (b.action === "accept") return { ok: true, wager: await acceptWager(b.tenantId, b.userId, b.wagerId ?? "") };
      if (b.action === "decline") {
        await declineWager(b.tenantId, b.userId, b.wagerId ?? "");
        return { ok: true };
      }
      await withdrawWager(b.tenantId, b.userId, b.wagerId ?? "");
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  // Campaign switches and poker runs (ADMIN/SUPERVISOR, or a team leader with manage_games; the web checks).
  app.post("/internal/games/bets", async (req, reply) => {
    const b = Ids.extend({ campaignId: z.string(), betsEnabled: z.boolean(), weeklyPoints: z.number(), maxStake: z.number() }).parse(req.body);
    try {
      return { ok: true, campaign: await setCampaignBets(b.tenantId, b.campaignId, b.userId, b) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/internal/games/bets-saved", async (req) => {
    const b = z.object({ tenantId: z.string(), campaignId: z.string(), credits: z.array(z.object({ userId: z.string(), delta: z.number(), reason: z.string() })).default([]) }).parse(req.body);
    await announceCampaignBets(b.tenantId, b.campaignId, b.credits);
    return { ok: true };
  });
  app.post("/internal/games/run", async (req, reply) => {
    const b = Ids.extend({
      action: z.enum(["start", "end"]),
      runId: z.string().optional(),
      campaignId: z.string().optional(),
      name: z.string().optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      prize: z.string().nullable().optional(),
      qualifies: z.string().optional(),
      codes: z.string().optional(),
    }).parse(req.body);
    try {
      if (b.action === "start") {
        const startsAt = new Date(b.startsAt ?? "");
        const endsAt = new Date(b.endsAt ?? "");
        if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("Pick when the run starts and ends");
        return { ok: true, run: await startPokerRun(b.tenantId, b.campaignId ?? "", b.userId, { name: b.name ?? "", startsAt, endsAt, prize: b.prize ?? null, rule: parsePokerRule(b.qualifies, b.codes) }) };
      }
      return { ok: true, run: await endPokerRun(b.tenantId, b.runId ?? "", b.userId) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- Agent assist
  app.post("/internal/assist/suggest", async (req) => {
    const b = z.object({ tenantId: z.string(), campaignId: z.string(), leadId: z.string().nullable(), objection: z.string().min(1).max(600), goal: z.enum(["sale", "service"]).optional() }).parse(req.body);
    return suggest(b.tenantId, b.campaignId, b.leadId, b.objection, b.goal ?? "sale");
  });

  // ---- Chat
  const Chan = z.object({ tenantId: z.string(), userId: z.string(), channel: z.enum(["EVERYONE", "MANAGERS", "TEAM", "CAMPAIGN", "DIRECT"]), channelId: z.string().nullable() });
  app.post("/internal/chat/send", async (req, reply) => {
    const b = Chan.extend({ body: z.string() }).parse(req.body);
    try {
      return { ok: true, message: await sendChat(b.tenantId, b.userId, b.channel, b.channelId, b.body) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/internal/chat/history", async (req) => {
    const b = Chan.parse(req.body);
    return { messages: await chatHistory(b.tenantId, b.userId, b.channel, b.channelId) };
  });

  app.get("/internal/provision/status", async (req) => provisionStatus(z.object({ tenantId: z.string() }).parse(req.query).tenantId));
  app.post("/internal/provision/setup", async (req, reply) => wrap(() => setupCarrier(z.object({ tenantId: z.string() }).parse(req.body).tenantId), reply));
  app.post("/internal/provision/search", async (req, reply) =>
    wrap(() => searchNumbers(z.object({ areaCode: z.string().optional(), state: z.string().optional(), locality: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).parse(req.body)), reply),
  );
  app.post("/internal/provision/order", async (req, reply) =>
    wrap(() => orderNumbers(z.object({ tenantId: z.string(), phones: z.array(z.string()).min(1).max(100), campaignId: z.string().nullable(), areaCode: z.string(), requestedBy: z.string().optional() }).parse(req.body)), reply),
  );
  app.post("/internal/provision/sync", async (req, reply) => wrap(() => syncNumbers(z.object({ tenantId: z.string() }).parse(req.body).tenantId), reply));
  app.post("/internal/provision/release", async (req, reply) => {
    const b = z.object({ tenantId: z.string(), id: z.string() }).parse(req.body);
    return wrap(async () => {
      await releaseNumber(b.tenantId, b.id);
      return { ok: true };
    }, reply);
  });
  // Free Caller Registry: drives their web form; several minutes. The reply carries ok/error rather than a status code.
  app.post("/internal/provision/fcr", async (req) => {
    const b = z.object({ tenantId: z.string(), ids: z.array(z.string()).optional() }).parse(req.body);
    return startFcrRun(b.tenantId, b.ids);
  });
  app.get("/internal/provision/fcr/status", async (req) => ({ progress: await fcrProgress(z.object({ tenantId: z.string() }).parse(req.query).tenantId) }));
  app.get("/internal/provision/tendlc", async (req) => tenDlcStatus(z.object({ tenantId: z.string() }).parse(req.query).tenantId));
  app.post("/internal/provision/tendlc/brand", async (req, reply) => {
    const b = z.object({ tenantId: z.string(), brand: z.custom<BrandInput>() }).parse(req.body);
    return wrap(() => createBrand(b.tenantId, b.brand), reply);
  });
  app.post("/internal/provision/tendlc/campaign", async (req, reply) => {
    const b = z.object({ tenantId: z.string(), campaign: z.custom<Omit<CampaignInput, "brandId">>() }).parse(req.body);
    return wrap(() => createTenDlcCampaign(b.tenantId, b.campaign), reply);
  });
  app.post("/internal/provision/tendlc/assign", async (req, reply) => wrap(() => assignNumbersToCampaign(z.object({ tenantId: z.string() }).parse(req.body).tenantId), reply));
  // Number planning (owner, 6 Nov): what a campaign (or one of its lists) needs, and applying it.
  const flag = (v: unknown, d: boolean) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === "1");
  app.get("/internal/campaigns/:id/did-plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ tenantId: z.string(), listId: z.string().optional(), poolFirst: z.string().optional(), exactOnly: z.string().optional() }).parse(req.query);
    return wrap(() => loadDidPlan(q.tenantId, id, { listId: q.listId || null, poolFirst: flag(q.poolFirst, true), exactOnly: flag(q.exactOnly, false) }), reply);
  });
  app.post("/internal/campaigns/:id/did-plan/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = Ids.extend({ listId: z.string().nullish(), poolFirst: z.boolean().optional(), exactOnly: z.boolean().optional(), requestedBy: z.string().optional() }).parse(req.body);
    return wrap(() => applyDidPlan({ tenantId: b.tenantId, campaignId: id, userId: b.userId, listId: b.listId ?? null, poolFirst: b.poolFirst ?? true, exactOnly: b.exactOnly ?? false, requestedBy: b.requestedBy }), reply);
  });
  app.get("/internal/provision/tendlc/fees", async (req, reply) => {
    const q = z.object({ tenantId: z.string(), usecase: z.string() }).parse(req.query);
    return wrap(() => usecaseFees(q.tenantId, q.usecase), reply);
  });
}
