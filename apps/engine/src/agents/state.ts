// Live agent state lives in Redis; the AgentSession row is the durable log.
import { prisma, type AgentState } from "@strowger/db";
import { redis } from "../redis";
import { emitToAgent, emitToTenant } from "../realtime";

export interface AgentLive {
  tenantId: string;
  userId: string;
  campaignId: string | null;
  sessionId: string | null;
  state: AgentState;
  /** jambonz call_sid of the agent's nailed-up leg, when it is up. */
  agentCallSid: string | null;
  /** Our Call.id for the lead the agent is on or wrapping up. */
  currentCallId: string | null;
  /** Lead reserved for preview, before a dial. */
  reservedLeadId: string | null;
  pauseReason: string | null;
  since: number;
}

const key = (userId: string) => `agent:${userId}`;
const tenantKey = (tenantId: string) => `tenant:${tenantId}:agents`;

export async function getAgent(userId: string): Promise<AgentLive | null> {
  const raw = await redis.get(key(userId));
  return raw ? (JSON.parse(raw) as AgentLive) : null;
}

export async function listAgents(tenantId: string): Promise<AgentLive[]> {
  const ids = await redis.smembers(tenantKey(tenantId));
  if (ids.length === 0) return [];
  const rows = await redis.mget(ids.map(key));
  return rows.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as AgentLive);
}

export async function setAgent(live: AgentLive): Promise<AgentLive> {
  await redis.set(key(live.userId), JSON.stringify(live));
  await redis.sadd(tenantKey(live.tenantId), live.userId);
  emitToAgent(live.userId, "agent:state", live);
  emitToTenant(live.tenantId, "floor:agent", live);
  return live;
}

export async function patchAgent(userId: string, patch: Partial<AgentLive>): Promise<AgentLive | null> {
  const cur = await getAgent(userId);
  if (!cur) return null;
  const next: AgentLive = { ...cur, ...patch };
  if (patch.state && patch.state !== cur.state) {
    next.since = Date.now();
    if (cur.sessionId) {
      await prisma.agentSession
        .update({
          where: { id: cur.sessionId },
          data: { lastState: patch.state, events: { push: { state: patch.state, at: new Date().toISOString(), reason: patch.pauseReason ?? null } } },
        })
        .catch(() => undefined);
    }
  }
  return setAgent(next);
}

export async function removeAgent(userId: string): Promise<void> {
  const cur = await getAgent(userId);
  if (!cur) return;
  await redis.del(key(userId));
  await redis.srem(tenantKey(cur.tenantId), userId);
  if (cur.sessionId) await prisma.agentSession.update({ where: { id: cur.sessionId }, data: { endedAt: new Date(), lastState: "LOGGED_OUT" } }).catch(() => undefined);
  const gone = { ...cur, state: "LOGGED_OUT" as AgentState, since: Date.now() };
  emitToAgent(userId, "agent:state", gone);
  emitToTenant(cur.tenantId, "floor:agent", gone);
}

/** Find the agent whose nailed-up leg is this jambonz call. */
export async function agentByCallSid(tenantId: string, callSid: string): Promise<AgentLive | null> {
  const all = await listAgents(tenantId);
  return all.find((a) => a.agentCallSid === callSid) ?? null;
}
