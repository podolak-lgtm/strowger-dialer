"use server";

// The agent console talks to the engine through these. Each one authorises
// the signed-in user and forwards tenantId + userId, so the engine never
// trusts the browser.
import { prisma } from "@strowger/db";
import { engine } from "@/lib/engine";
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
};

export async function nextLead(): Promise<Ok<{ lead: LeadCard }> | Err> {
  const s = await me();
  return engine("/leads/next", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
}

export async function leadById(leadId: string): Promise<LeadCard | null> {
  const s = await me();
  const l = await prisma.lead.findFirst({ where: { id: leadId, tenantId: s.tenant.id } });
  return l ? ({ ...l, postedAt: l.postedAt.toISOString(), custom: (l.custom ?? {}) as Record<string, unknown> } as unknown as LeadCard) : null;
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

export async function disposition(input: { callId: string; dispositionId: string; notes?: string; callbackAt?: string; callbackScope?: "AGENT" | "CAMPAIGN" }): Promise<Ok<object> | Err> {
  const s = await me();
  const own = await prisma.call.findFirst({ where: { id: input.callId, tenantId: s.tenant.id, agentId: s.user.id }, select: { id: true } });
  if (!own) return { ok: false, error: "Not your call" };
  return engine(`/calls/${input.callId}/disposition`, { method: "POST", body: JSON.stringify({ ...input, userId: s.user.id }) });
}

export async function updateLeadNotes(leadId: string, data: { firstName?: string; lastName?: string; email?: string; note?: string }): Promise<{ ok: boolean }> {
  const s = await me();
  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: s.tenant.id } });
  if (!lead) return { ok: false };
  const { note, ...fields } = data;
  await prisma.lead.update({ where: { id: leadId }, data: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  if (note?.trim()) await prisma.leadEvent.create({ data: { tenantId: s.tenant.id, leadId, kind: "NOTE", actorId: s.user.id, data: { note: note.trim() } } });
  return { ok: true };
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

export type TextMessage = { id: string; direction: "INBOUND" | "OUTBOUND"; body: string; at: string; status: string; purpose: string | null };

export async function textThread(leadId: string): Promise<TextMessage[]> {
  const s = await me();
  const rows = await prisma.message.findMany({ where: { leadId, tenantId: s.tenant.id }, orderBy: { createdAt: "asc" }, take: 50 });
  return rows.map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.createdAt.toISOString(), status: m.status, purpose: m.purpose }));
}

export async function sendText(leadId: string, body: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
  return engine("/sms/send", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, leadId, body }) });
}

export async function leaveVoicemail(callId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await me();
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
