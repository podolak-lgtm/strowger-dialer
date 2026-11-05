"use server";

// Floor chat, for the console and the floor. The engine decides who may use a
// channel and delivers over the socket (apps/engine/src/chat).
import { prisma } from "@strowger/db";
import { requireSession } from "@/lib/auth";
import { engine } from "@/lib/engine";

export type ChatChannelKind = "EVERYONE" | "MANAGERS" | "TEAM" | "CAMPAIGN" | "DIRECT";
export type ChatChannelRef = { kind: ChatChannelKind; id: string | null; label: string };
export type ChatMsg = { id: string; channel: ChatChannelKind; channelId: string | null; senderId: string; senderName: string; body: string; at: string };

const MANAGER_ROLES = ["ADMIN", "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER"];

/** The channels this person can post in, plus the people they can message directly. */
export async function chatChannels(): Promise<{ channels: ChatChannelRef[]; people: { id: string; name: string; manager: boolean }[]; me: string }> {
  const s = await requireSession();
  const manager = s.roles.some((r) => MANAGER_ROLES.includes(r));
  const [teams, led, campaigns, people] = await Promise.all([
    prisma.team.findMany({ where: { tenantId: s.tenant.id, members: { some: { userId: s.user.id } } }, select: { id: true, name: true } }),
    prisma.team.findMany({ where: { tenantId: s.tenant.id, leaderId: s.user.id }, select: { id: true, name: true } }),
    manager
      ? prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: "ACTIVE", agents: { some: { userId: s.user.id } } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true, id: { not: s.user.id }, roles: { hasSome: ["AGENT", "TEAM_LEADER", "ROOM_SUPERVISOR", "SUPERVISOR", "ADMIN"] } }, select: { id: true, firstName: true, email: true, roles: true }, orderBy: [{ firstName: "asc" }, { email: "asc" }] }),
  ]);
  const seen = new Set<string>();
  const channels: ChatChannelRef[] = [{ kind: "EVERYONE", id: null, label: "Everyone" }];
  if (manager) channels.push({ kind: "MANAGERS", id: null, label: "Managers only" });
  for (const t of [...led, ...teams]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    channels.push({ kind: "TEAM", id: t.id, label: `Team · ${t.name}` });
  }
  for (const c of campaigns) channels.push({ kind: "CAMPAIGN", id: c.id, label: `Campaign · ${c.name}` });
  return { channels, people: people.map((p) => ({ id: p.id, name: p.firstName ?? p.email.split("@")[0]!, manager: p.roles.some((r) => MANAGER_ROLES.includes(r)) })), me: s.user.id };
}

export async function chatHistory(kind: ChatChannelKind, id: string | null): Promise<ChatMsg[]> {
  const s = await requireSession();
  const r = await engine<{ messages: ChatMsg[] }>("/chat/history", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, channel: kind, channelId: id }) });
  return r.messages;
}

export async function chatSend(kind: ChatChannelKind, id: string | null, body: string): Promise<{ ok: true; message: ChatMsg } | { ok: false; error: string }> {
  const s = await requireSession();
  try {
    return await engine("/chat/send", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, channel: kind, channelId: id, body }) });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** For the console's My Team panel: the teams this person leads and their members. */
export async function myTeams(): Promise<{ id: string; name: string; members: { id: string; name: string }[] }[]> {
  const s = await requireSession();
  const teams = await prisma.team.findMany({ where: { tenantId: s.tenant.id, leaderId: s.user.id }, select: { id: true, name: true, members: { select: { user: { select: { id: true, firstName: true, email: true } } } } } });
  return teams.map((t) => ({ id: t.id, name: t.name, members: t.members.map((m) => ({ id: m.user.id, name: m.user.firstName ?? m.user.email.split("@")[0]! })) }));
}
