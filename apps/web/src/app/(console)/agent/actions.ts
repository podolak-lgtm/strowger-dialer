"use server";

// The agent console talks to the engine through these. Each one authorises
// the signed-in user and forwards tenantId + userId, so the engine never
// trusts the browser.
import { prisma } from "@strowger/db";
import { engine } from "@/lib/engine";
import { requireRight } from "@/lib/rights";
import { requireRole } from "@/lib/auth";

export type AgentLive = {
  tenantId: string;
  userId: string;
  campaignId: string | null;
  sessionId: string | null;
  state: "LOGGED_IN" | "READY" | "RESERVED" | "ON_CALL" | "WRAP_UP" | "PAUSED" | "LOGGED_OUT";
  agentCallSid: string | null;
  currentCallId: string | null;
  reservedLeadId: string | null;
  pauseReason: string | null;
  since: number;
};

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

async function me() {
  return requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
}

export async function agentLogin(campaignId: string): Promise<Ok<{ agent: AgentLive }> | Err> {
  const s = await me();
  return engine("/agents/login", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, campaignId }) });
}

export async function agentSetState(state: "READY" | "PAUSED", reason?: string): Promise<Ok<{ agent: AgentLive }> | Err> {
  const s = await me();
  return engine("/agents/state", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, state, reason }) });
}

export async function agentLogout(): Promise<{ ok: boolean }> {
  const s = await me();
  return engine("/agents/logout", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
}

export async function agentCurrent(): Promise<AgentLive | null> {
  const s = await me();
  const r = await engine<{ agent: AgentLive | null }>(`/agents/${s.user.id}`);
  return r.agent;
}

export type LeadCard = {
  id: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
  timezone: string | null;
  leadType: string | null;
  postedAt: string;
  attemptsTotal: number;
  custom: Record<string, unknown>;
  listId: string;
  // Everything else the Lead card shows (owner, 5 Nov: the agent works from the card, so it carries every field).
  listName: string;
  affiliateName: string | null;
  status: string;
  scrubStatus: string;
  scrubReason: string | null;
  consentJornayaId: string | null;
  consentTrustedFormId: string | null;
  optInUrl: string | null;
  optInAt: string | null;
  optInIp: string | null;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  ownerName: string | null;
  notes: string | null;
};

/** The fields an agent may change from the Lead card. */
export type LeadEdit = { firstName?: string; lastName?: string; email?: string; address?: string; city?: string; state?: string; zip?: string };
const LEAD_EDIT_FIELDS = ["firstName", "lastName", "email", "address", "city", "state", "zip"] as const;

const leadCardSelect = {
  id: true,
  phone: true,
  firstName: true,
  lastName: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  email: true,
  timezone: true,
  leadType: true,
  postedAt: true,
  attemptsTotal: true,
  custom: true,
  listId: true,
  status: true,
  scrubStatus: true,
  scrubReason: true,
  consentJornayaId: true,
  consentTrustedFormId: true,
  optInUrl: true,
  optInAt: true,
  optInIp: true,
  lastAttemptAt: true,
  notes: true,
  list: { select: { name: true, affiliate: { select: { name: true } } } },
  owner: { select: { firstName: true, lastName: true, email: true } },
  calls: { orderBy: { dialedAt: "desc" as const }, take: 1, select: { outcome: true, disposition: { select: { label: true } } } },
} as const;

async function loadLeadCard(tenantId: string, leadId: string): Promise<LeadCard | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, tenantId }, select: leadCardSelect });
  if (!l) return null;
  const { list, owner, calls, ...rest } = l;
  return {
    ...rest,
    postedAt: l.postedAt.toISOString(),
    optInAt: l.optInAt?.toISOString() ?? null,
    lastAttemptAt: l.lastAttemptAt?.toISOString() ?? null,
    custom: (l.custom ?? {}) as Record<string, unknown>,
    listName: list.name,
    affiliateName: list.affiliate?.name ?? null,
    lastOutcome: calls[0]?.disposition?.label ?? calls[0]?.outcome ?? null,
    ownerName: owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email : null,
  };
}

export async function nextLead(): Promise<Ok<{ lead: LeadCard }> | Err> {
  const s = await me();
  const r = await engine<Ok<{ lead: { id: string } }> | Err>("/leads/next", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
  if (!r.ok) return r;
  const lead = await loadLeadCard(s.tenant.id, r.lead.id);
  return lead ? { ok: true, lead } : { ok: false, error: "Lead not found" };
}

export async function leadById(leadId: string): Promise<LeadCard | null> {
  const s = await me();
  return loadLeadCard(s.tenant.id, leadId);
}

export async function skipLead(leadId: string): Promise<{ ok: boolean }> {
  const s = await me();
  return engine("/leads/skip", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, leadId }) });
}

export async function dialLead(leadId: string): Promise<Ok<{ callId: string }> | Err> {
  const s = await me();
  return engine("/calls/dial", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, leadId }) });
}

export async function hangup(callId: string): Promise<{ ok: boolean }> {
  const s = await me();
  const own = await prisma.call.findFirst({ where: { id: callId, tenantId: s.tenant.id, agentId: s.user.id }, select: { id: true } });
  if (!own) return { ok: false };
  return engine(`/calls/${callId}/hangup`, { method: "POST", body: "{}" });
}

/** Without `dispositionId` the call is a callback: the engine uses the campaign's callback disposition, creating "Callback" (CB) if the campaign has none. */
export async function disposition(input: { callId: string; dispositionId?: string; notes?: string; callbackAt?: string; /** Quick callback: due this many minutes from now (computed here, the console render stays pure). */ callbackInMinutes?: number; callbackScope?: "AGENT" | "CAMPAIGN" }): Promise<Ok<object> | Err> {
  const s = await me();
  const own = await prisma.call.findFirst({ where: { id: input.callId, tenantId: s.tenant.id, agentId: s.user.id }, select: { id: true } });
  if (!own) return { ok: false, error: "Not your call" };
  const { callbackInMinutes, ...rest } = input;
  const callbackAt = rest.callbackAt ?? (callbackInMinutes ? new Date(Date.now() + callbackInMinutes * 60_000).toISOString() : undefined);
  return engine(`/calls/${input.callId}/disposition`, { method: "POST", body: JSON.stringify({ ...rest, callbackAt, userId: s.user.id }) });
}

/**
 * Save edits from the Lead card. Changed fields are written to the lead and a
 * NOTE event records what changed (`changes: {field: {from, to}}`) alongside
 * the note text, so the history shows who corrected what. `notes` replaces
 * the lead's running notes; the event carries the new text.
 */
export async function updateLead(leadId: string, data: LeadEdit & { notes?: string }): Promise<Ok<{ lead: LeadCard }> | Err> {
  const s = await me();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: s.tenant.id } });
  if (!lead) return { ok: false, error: "Lead not found" };
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  const patch: Record<string, string | null> = {};
  for (const f of LEAD_EDIT_FIELDS) {
    const v = data[f];
    if (v === undefined) continue;
    const to = v.trim() || null;
    if (to === lead[f]) continue;
    changes[f] = { from: lead[f], to };
    patch[f] = to;
  }
  if (data.notes !== undefined) {
    const to = data.notes.trim() || null;
    if (to !== lead.notes) {
      changes.notes = { from: lead.notes, to };
      patch.notes = to;
    }
  }
  if (Object.keys(patch).length) {
    await prisma.lead.update({ where: { id: leadId }, data: patch });
    await prisma.leadEvent.create({ data: { tenantId: s.tenant.id, leadId, kind: "NOTE", actorId: s.user.id, data: { ...(patch.notes ? { note: patch.notes } : {}), changes } } });
  }
  const card = await loadLeadCard(s.tenant.id, leadId);
  return card ? { ok: true, lead: card } : { ok: false, error: "Lead not found" };
}

export type LeadHistory = { kind: string; at: string; data: Record<string, unknown>; actor: string | null }[];

export async function leadHistory(leadId: string): Promise<LeadHistory> {
  const s = await me();
  const events = await prisma.leadEvent.findMany({
    where: { leadId, tenantId: s.tenant.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { actor: { select: { firstName: true, email: true } } },
  });
  return events.map((e) => ({ kind: e.kind, at: e.createdAt.toISOString(), data: e.data as Record<string, unknown>, actor: e.actor?.firstName ?? e.actor?.email ?? null }));
}

export type Sprint = {
  dials: number;
  contacts: number;
  sales: number;
  talkSeconds: number;
  goals: { dials: number; contacts: number; sales: number };
  leaderboard: { userId: string; name: string; sales: number; contacts: number; dials: number; you: boolean }[];
  queueDepth: number;
  callbacksDue: number;
  feed: { at: string; text: string; tone: "sms" | "lead" | "call" | "alert" }[];
};

export async function sprint(campaignId: string | null): Promise<Sprint> {
  const s = await me();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const where = { tenantId: s.tenant.id, dialedAt: { gte: since }, ...(campaignId ? { campaignId } : {}) };
  const [mine, all, queueDepth, callbacksDue, recent] = await Promise.all([
    prisma.call.findMany({ where: { ...where, agentId: s.user.id }, include: { disposition: true } }),
    prisma.call.findMany({ where, include: { disposition: true } }),
    campaignId
      ? prisma.lead.count({ where: { list: { campaignId, status: "ACTIVE" }, status: { in: ["NEW", "CONTACTED", "CALLBACK"] }, scrubStatus: { notIn: ["DNC", "LITIGATOR"] }, OR: [{ nextDialAt: null }, { nextDialAt: { lte: new Date() } }] } })
      : Promise.resolve(0),
    campaignId ? prisma.callback.count({ where: { campaignId, status: "SCHEDULED", dueAt: { lte: new Date() } } }) : Promise.resolve(0),
    prisma.leadEvent.findMany({
      where: { tenantId: s.tenant.id, kind: { in: ["POSTED", "TEXT_IN", "CALLBACK_SET", "DISPOSITION"] }, ...(campaignId ? { lead: { list: { campaignId } } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { lead: { select: { firstName: true, lastName: true, city: true, state: true } } },
    }),
  ]);
  const settings = (s.tenant.settings ?? {}) as { goals?: { dials?: number; contacts?: number; sales?: number } };
  const goals = { dials: settings.goals?.dials ?? 200, contacts: settings.goals?.contacts ?? 20, sales: settings.goals?.sales ?? 3 };

  const users = await prisma.user.findMany({ where: { tenantId: s.tenant.id, id: { in: [...new Set(all.map((c) => c.agentId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, firstName: true, lastName: true, email: true } });
  const board = users
    .map((u) => {
      const calls = all.filter((c) => c.agentId === u.id);
      return {
        userId: u.id,
        name: u.firstName ? `${u.firstName} ${u.lastName?.[0] ?? ""}`.trim() : u.email.split("@")[0]!,
        sales: calls.filter((c) => c.disposition?.isSale).length,
        contacts: calls.filter((c) => c.disposition?.isContact).length,
        dials: calls.length,
        you: u.id === s.user.id,
      };
    })
    .sort((a, b) => b.sales - a.sales || b.contacts - a.contacts || b.dials - a.dials)
    .slice(0, 5);

  const feed = recent.map((e) => {
    const who = [e.lead.firstName, e.lead.lastName].filter(Boolean).join(" ") || "A lead";
    const where = [e.lead.city, e.lead.state].filter(Boolean).join(", ");
    const d = e.data as Record<string, unknown>;
    const text =
      e.kind === "POSTED"
        ? `New lead posted: ${who}${where ? ` (${where})` : ""}`
        : e.kind === "TEXT_IN"
          ? `SMS reply received from ${who}`
          : e.kind === "CALLBACK_SET"
            ? `Callback scheduled with ${who}`
            : `${who}: ${String(d.code ?? "dispositioned")}`;
    return { at: e.createdAt.toISOString(), text, tone: (e.kind === "TEXT_IN" ? "sms" : e.kind === "POSTED" ? "lead" : "call") as "sms" | "lead" | "call" };
  });

  return {
    dials: mine.length,
    contacts: mine.filter((c) => c.disposition?.isContact).length,
    sales: mine.filter((c) => c.disposition?.isSale).length,
    talkSeconds: mine.reduce((n, c) => n + (c.bridgedAt && c.endedAt ? Math.max(0, (c.endedAt.getTime() - c.bridgedAt.getTime()) / 1000) : 0), 0),
    goals,
    leaderboard: board,
    queueDepth,
    callbacksDue,
    feed,
  };
}

export type TextMessage = { id: string; direction: "INBOUND" | "OUTBOUND"; body: string; at: string; status: string; purpose: string | null; intent: string | null };

export async function textThread(leadId: string): Promise<TextMessage[]> {
  const s = await me();
  const rows = await prisma.message.findMany({ where: { leadId, tenantId: s.tenant.id }, orderBy: { createdAt: "asc" }, take: 50 });
  return rows.map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.createdAt.toISOString(), status: m.status, purpose: m.purpose, intent: m.intent }));
}

export async function sendText(leadId: string, body: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
  requireRight(s, "send_text");
  return engine("/sms/send", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, leadId, body }) });
}

export async function leaveVoicemail(callId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
  requireRight(s, "voicemail_drop");
  return engine(`/calls/${callId}/voicemail`, { method: "POST", body: JSON.stringify({ userId: s.user.id }) });
}

// ── Assist screen data ─────────────────────────────────────────────────────

export type UpcomingLead = { id: string; name: string; phone: string; location: string; listName: string; priority: number; attempts: number; lastOutcome: string | null; nextDialAt: string | null; localTime: string | null };

/** The next leads the hopper would offer this campaign, read-only. */
export async function upcomingLeads(campaignId: string | null, limit = 6): Promise<UpcomingLead[]> {
  const s = await me();
  if (!campaignId) return [];
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { hopperOrder: true } });
  if (!campaign) return [];
  const rows = await prisma.lead.findMany({
    where: { tenantId: s.tenant.id, list: { campaignId, status: "ACTIVE" }, status: { in: ["NEW", "CONTACTED", "CALLBACK"] }, scrubStatus: { notIn: ["DNC", "LITIGATOR"] }, timezone: { not: null }, OR: [{ nextDialAt: null }, { nextDialAt: { lte: new Date() } }], ownerId: null },
    orderBy: [{ list: { priority: "asc" } }, { postedAt: campaign.hopperOrder === "FIFO" ? "asc" : "desc" }],
    take: limit,
    include: { list: { select: { name: true, priority: true } }, calls: { orderBy: { dialedAt: "desc" }, take: 1, select: { outcome: true, disposition: { select: { label: true } } } } },
  });
  return rows.map((l) => ({
    id: l.id,
    name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown",
    phone: l.phone,
    location: [l.city, l.state].filter(Boolean).join(", "),
    listName: l.list.name,
    priority: l.list.priority,
    attempts: l.attemptsTotal,
    lastOutcome: l.calls[0]?.disposition?.label ?? l.calls[0]?.outcome ?? null,
    nextDialAt: l.nextDialAt?.toISOString() ?? null,
    localTime: l.timezone ? new Intl.DateTimeFormat("en-US", { timeZone: l.timezone, hour: "numeric", minute: "2-digit" }).format(new Date()) : null,
  }));
}

export type MyCallback = { id: string; leadId: string; name: string; phone: string; dueAt: string; note: string | null; scope: string; overdue: boolean };

export async function myCallbacks(campaignId: string | null): Promise<MyCallback[]> {
  const s = await me();
  const rows = await prisma.callback.findMany({
    where: { tenantId: s.tenant.id, status: "SCHEDULED", OR: [{ agentId: s.user.id }, { scope: "CAMPAIGN", ...(campaignId ? { campaignId } : {}) }], dueAt: { lte: new Date(Date.now() + 8 * 3600_000) } },
    orderBy: { dueAt: "asc" },
    take: 12,
    include: { lead: { select: { firstName: true, lastName: true, phone: true } } },
  });
  return rows.map((c) => ({ id: c.id, leadId: c.leadId, name: [c.lead.firstName, c.lead.lastName].filter(Boolean).join(" ") || "Unknown", phone: c.lead.phone, dueAt: c.dueAt.toISOString(), note: c.note, scope: c.scope, overdue: c.dueAt.getTime() < Date.now() }));
}

export async function campaignScript(campaignId: string | null): Promise<string | null> {
  const s = await me();
  if (!campaignId) return null;
  const sc = await prisma.script.findFirst({ where: { tenantId: s.tenant.id, campaignId, active: true }, orderBy: { version: "desc" } });
  return sc?.body ?? null;
}

export async function holdCall(callId: string, hold: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
  return engine(`/calls/${callId}/hold`, { method: "POST", body: JSON.stringify({ userId: s.user.id, hold }) });
}

export type TransferTarget = { userId: string; name: string; mode: string; since: number };
export async function transferTargets(campaignId: string | null): Promise<TransferTarget[]> {
  const s = await me();
  const r = await engine<{ targets: TransferTarget[] }>(`/transfer-targets?tenantId=${s.tenant.id}&userId=${s.user.id}${campaignId ? `&campaignId=${campaignId}` : ""}`);
  return r.targets;
}

export async function transferCall(callId: string, toAgentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
  requireRight(s, "transfer");
  return engine(`/calls/${callId}/transfer`, { method: "POST", body: JSON.stringify({ userId: s.user.id, toAgentId }) });
}

export async function manualDial(phone: string): Promise<{ ok: true; callId: string } | { ok: false; error: string }> {
  const s = await me();
  requireRight(s, "manual_dial");
  return engine("/calls/manual", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, phone }) });
}
