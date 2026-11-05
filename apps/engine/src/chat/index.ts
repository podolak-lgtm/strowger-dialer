// Floor chat: who may post to a channel, who receives it, and delivery over
// the socket. Channels: EVERYONE, MANAGERS, TEAM (members + leader),
// CAMPAIGN (its agents + every manager), DIRECT (two people).
import { prisma, type ChatChannel, type Role } from "@strowger/db";
import { emitToAgent, emitToTenant } from "../realtime";

const MANAGER_ROLES: Role[] = ["ADMIN", "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER"];

export interface ChatMsg {
  id: string;
  channel: ChatChannel;
  channelId: string | null;
  senderId: string;
  senderName: string;
  body: string;
  at: string;
}

export const directKey = (a: string, b: string) => [a, b].sort().join(":");

async function isManager(tenantId: string, userId: string): Promise<boolean> {
  const u = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { roles: true } });
  return Boolean(u && u.roles.some((r) => MANAGER_ROLES.includes(r)));
}

/** May this user read and write the channel? */
export async function mayUse(tenantId: string, userId: string, channel: ChatChannel, channelId: string | null): Promise<boolean> {
  switch (channel) {
    case "EVERYONE":
      return true;
    case "MANAGERS":
      return isManager(tenantId, userId);
    case "TEAM": {
      if (!channelId) return false;
      const t = await prisma.team.findFirst({ where: { id: channelId, tenantId }, select: { leaderId: true, members: { select: { userId: true } } } });
      return Boolean(t && (t.leaderId === userId || t.members.some((m) => m.userId === userId))) || isManager(tenantId, userId);
    }
    case "CAMPAIGN": {
      if (!channelId) return false;
      const a = await prisma.campaignAgent.findFirst({ where: { campaignId: channelId, userId, campaign: { tenantId } } });
      return Boolean(a) || isManager(tenantId, userId);
    }
    case "DIRECT":
      return Boolean(channelId && channelId.split(":").includes(userId));
  }
}

/** Everyone who should see a message on the channel. */
async function recipients(tenantId: string, channel: ChatChannel, channelId: string | null): Promise<string[] | "tenant"> {
  switch (channel) {
    case "EVERYONE":
      return "tenant";
    case "MANAGERS":
      return (await prisma.user.findMany({ where: { tenantId, active: true, roles: { hasSome: MANAGER_ROLES } }, select: { id: true } })).map((u) => u.id);
    case "TEAM": {
      const t = await prisma.team.findFirst({ where: { id: channelId ?? "", tenantId }, select: { leaderId: true, members: { select: { userId: true } } } });
      if (!t) return [];
      return [...new Set([...(t.leaderId ? [t.leaderId] : []), ...t.members.map((m) => m.userId)])];
    }
    case "CAMPAIGN": {
      const [agents, managers] = await Promise.all([
        prisma.campaignAgent.findMany({ where: { campaignId: channelId ?? "", campaign: { tenantId } }, select: { userId: true } }),
        prisma.user.findMany({ where: { tenantId, active: true, roles: { hasSome: MANAGER_ROLES } }, select: { id: true } }),
      ]);
      return [...new Set([...agents.map((a) => a.userId), ...managers.map((u) => u.id)])];
    }
    case "DIRECT":
      return (channelId ?? "").split(":").filter(Boolean);
  }
}

export async function sendChat(tenantId: string, senderId: string, channel: ChatChannel, channelId: string | null, body: string): Promise<ChatMsg> {
  const text = body.trim().slice(0, 2000);
  if (!text) throw new Error("Empty message");
  if (!(await mayUse(tenantId, senderId, channel, channelId))) throw new Error("You are not in that channel");
  const row = await prisma.chatMessage.create({ data: { tenantId, senderId, channel, channelId, body: text }, include: { sender: { select: { firstName: true, email: true } } } });
  const msg: ChatMsg = { id: row.id, channel, channelId, senderId, senderName: row.sender.firstName ?? row.sender.email.split("@")[0]!, body: text, at: row.createdAt.toISOString() };
  const to = await recipients(tenantId, channel, channelId);
  if (to === "tenant") emitToTenant(tenantId, "chat:message", msg);
  else for (const id of to) emitToAgent(id, "chat:message", msg);
  return msg;
}

export async function chatHistory(tenantId: string, userId: string, channel: ChatChannel, channelId: string | null, limit = 50): Promise<ChatMsg[]> {
  if (!(await mayUse(tenantId, userId, channel, channelId))) return [];
  const rows = await prisma.chatMessage.findMany({ where: { tenantId, channel, channelId }, orderBy: { createdAt: "desc" }, take: limit, include: { sender: { select: { firstName: true, email: true } } } });
  return rows.reverse().map((r) => ({ id: r.id, channel: r.channel, channelId: r.channelId, senderId: r.senderId, senderName: r.sender.firstName ?? r.sender.email.split("@")[0]!, body: r.body, at: r.createdAt.toISOString() }));
}
