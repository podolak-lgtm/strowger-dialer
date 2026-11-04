"use server";

import { prisma } from "@strowger/db";
import { engine } from "@/lib/engine";
import { hasRole, requireRole } from "@/lib/auth";
import type { AgentLive } from "../agent/actions";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

async function me() {
  return requireRole("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
}

export type SuperviseMode = "LISTEN" | "WHISPER" | "BARGE";
export type Supervision = { tenantId: string; supervisorId: string; agentId: string; mode: SuperviseMode; callSid: string | null; callId: string | null; since: number; ended?: boolean };

export async function superviseStart(agentId: string, mode: SuperviseMode): Promise<Ok<object> | Err> {
  const s = await me();
  return engine("/supervise/start", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, agentId, mode }) });
}
export async function superviseMode(mode: SuperviseMode): Promise<Ok<object> | Err> {
  const s = await me();
  return engine("/supervise/mode", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, mode }) });
}
export async function superviseTakeover(): Promise<Ok<object> | Err> {
  const s = await me();
  return engine("/supervise/takeover", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
}
export async function superviseStop(): Promise<{ ok: boolean }> {
  const s = await me();
  return engine("/supervise/stop", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
}
export async function superviseCurrent(): Promise<Supervision | null> {
  const s = await me();
  const r = await engine<{ supervision: Supervision | null }>(`/supervise/${s.user.id}`);
  return r.supervision;
}

export type FloorAgent = AgentLive & {
  name: string;
  campaignName: string | null;
  dials: number;
  handled: number;
  talkSeconds: number;
  transfers: number;
  sales: number;
  leadName: string | null;
  leadPhone: string | null;
};

export type FloorStats = {
  totalDials: number;
  connected: number;
  conversations: number;
  successRate: number;
  sales: number;
  dropped: number;
  inProgress: number;
  activeCampaigns: number;
  agentsActive: number;
  agentsOnCall: number;
  queueWaitSeconds: number;
  volume: number[]; // calls per 5-minute bucket, last 60 minutes
  campaigns: { id: string; name: string; status: string }[];
  agents: FloorAgent[];
  history: { at: string; action: string; actor: string; target: string | null }[];
  team: { label: string; total: number; rate: number }[];
};

/** Everything both supervisor screens show, in one call. */
export async function floorStats(campaignId: string | null): Promise<FloorStats> {
  const s = await me();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const whereDay = { tenantId: s.tenant.id, dialedAt: { gte: since }, ...(campaignId ? { campaignId } : {}) };

  const [live, calls, campaigns, history, users] = await Promise.all([
    engine<{ agents: AgentLive[] }>(`/floor?tenantId=${s.tenant.id}`).then((r) => r.agents).catch(() => [] as AgentLive[]),
    prisma.call.findMany({ where: whereDay, include: { disposition: { select: { isContact: true, isSale: true } }, transfers: { select: { id: true } } } }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.auditLog.findMany({ where: { tenantId: s.tenant.id, action: { startsWith: "supervise." } }, orderBy: { createdAt: "desc" }, take: 12, include: { actor: { select: { firstName: true, email: true } } } }),
    prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true }, select: { id: true, firstName: true, lastName: true, email: true } }),
  ]);

  // Team leaders see their team; room supervisors their room; supervisors everything.
  let visible = new Set(users.map((u) => u.id));
  if (!hasRole(s, "SUPERVISOR")) {
    const [teams, rooms] = await Promise.all([
      prisma.team.findMany({ where: { tenantId: s.tenant.id, leaderId: s.user.id }, include: { members: true } }),
      prisma.room.findMany({ where: { tenantId: s.tenant.id, supervisorId: s.user.id }, include: { members: true } }),
    ]);
    visible = new Set([...teams.flatMap((t) => t.members.map((m) => m.userId)), ...rooms.flatMap((r) => r.members.map((m) => m.userId))]);
  }

  const nameOf = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.firstName ? `${u.firstName} ${u.lastName ?? ""}`.trim() : u.email.split("@")[0]!) : "Unknown";
  };
  const leadIds = live.map((a) => a.currentCallId).filter((x): x is string => Boolean(x));
  const liveCalls = leadIds.length ? await prisma.call.findMany({ where: { id: { in: leadIds } }, include: { lead: { select: { firstName: true, lastName: true, phone: true } } } }) : [];

  const agents: FloorAgent[] = live
    .filter((a) => visible.has(a.userId) && (!campaignId || a.campaignId === campaignId))
    .map((a) => {
      const mine = calls.filter((c) => c.agentId === a.userId);
      const lc = liveCalls.find((c) => c.id === a.currentCallId);
      return {
        ...a,
        name: nameOf(a.userId),
        campaignName: campaigns.find((c) => c.id === a.campaignId)?.name ?? null,
        dials: mine.length,
        handled: mine.filter((c) => c.bridgedAt).length,
        talkSeconds: mine.reduce((n, c) => n + (c.bridgedAt ? ((c.endedAt ?? new Date()).getTime() - c.bridgedAt.getTime()) / 1000 : 0), 0),
        transfers: mine.reduce((n, c) => n + c.transfers.length, 0),
        sales: mine.filter((c) => c.disposition?.isSale).length,
        leadName: lc?.lead ? [lc.lead.firstName, lc.lead.lastName].filter(Boolean).join(" ") || null : null,
        leadPhone: lc?.lead?.phone ?? null,
      };
    })
    .sort((a, b) => (a.state === "ON_CALL" ? -1 : 1) - (b.state === "ON_CALL" ? -1 : 1) || a.name.localeCompare(b.name));

  const connected = calls.filter((c) => c.bridgedAt).length;
  const sales = calls.filter((c) => c.disposition?.isSale).length;
  const now = Date.now();
  const volume = Array.from({ length: 12 }, (_, i) => {
    const start = now - (12 - i) * 5 * 60_000;
    const end = start + 5 * 60_000;
    return calls.filter((c) => c.dialedAt.getTime() >= start && c.dialedAt.getTime() < end).length;
  });
  const callbacksDue = campaignId ? await prisma.callback.findFirst({ where: { campaignId, status: "SCHEDULED", dueAt: { lte: new Date() } }, orderBy: { dueAt: "asc" } }) : null;

  const days = [0, 1, 2].map((d) => {
    const from = new Date(since.getTime() - d * 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    return { from, to, label: d === 0 ? "Today" : d === 1 ? "Yesterday" : from.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }) };
  });
  const olderCalls = await prisma.call.findMany({ where: { tenantId: s.tenant.id, dialedAt: { gte: days[2]!.from }, ...(campaignId ? { campaignId } : {}) }, select: { dialedAt: true, bridgedAt: true, disposition: { select: { isSale: true } } } });
  const team = days.map((d) => {
    const rows = olderCalls.filter((c) => c.dialedAt >= d.from && c.dialedAt < d.to);
    const conn = rows.filter((c) => c.bridgedAt).length;
    return { label: d.label, total: rows.length, rate: conn ? Math.round((rows.filter((c) => c.disposition?.isSale).length / conn) * 1000) / 10 : 0 };
  });

  return {
    totalDials: calls.length,
    connected,
    conversations: calls.filter((c) => c.disposition?.isContact).length,
    successRate: connected ? Math.round((sales / connected) * 1000) / 10 : 0,
    sales,
    dropped: calls.filter((c) => !c.bridgedAt && c.endedAt).length,
    inProgress: calls.filter((c) => !c.endedAt).length,
    activeCampaigns: campaigns.filter((c) => c.status === "ACTIVE").length,
    agentsActive: agents.filter((a) => a.state !== "LOGGED_OUT").length,
    agentsOnCall: agents.filter((a) => a.state === "ON_CALL").length,
    queueWaitSeconds: callbacksDue ? Math.max(0, Math.round((Date.now() - callbacksDue.dueAt.getTime()) / 1000)) : 0,
    volume,
    campaigns,
    agents,
    history: history.map((h) => ({ at: h.createdAt.toISOString(), action: h.action.replace("supervise.", ""), actor: h.actor?.firstName ?? h.actor?.email ?? "?", target: h.target ? nameOf(h.target) : null })),
    team,
  };
}
