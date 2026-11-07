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
  /** Ready was asked for before the line was up: the line joining makes the agent READY (owner, 6 Nov: log in paused, then go Ready). */
  readyOnLine?: boolean;
  /** Where the agent goes after dispositioning the current call: PAUSED for a call they dialled by hand (owner, 6 Nov). */
  afterCall?: "PAUSED" | null;
  /** WRAP_UP after an inbound queue call ends here (ms): the queue tick returns the agent to Ready, or clears the call if they paused (inbound/queues.ts). */
  wrapUntil?: number | null;
  /** The ratio dialer counts this agent only from this time (ms): READY_DIAL_GRACE_MS after they click Ready. */
  dialAfter?: number | null;
}

/**
 * Owner, 7 Nov: wait 10 seconds after an agent goes Ready before dialing for them, so a quick Pause → Ready by
 * mistake (or Ready → Pause) never leaves an answered customer with no agent (an abandoned call). Only a Ready
 * the agent asked for (from Paused, logged in, or a line coming up); back to Ready after a call is at once, or
 * every call would cost ten seconds.
 */
export const READY_DIAL_GRACE_MS = 10_000;
const GRACE_FROM: readonly AgentState[] = ["PAUSED", "LOGGED_IN", "LOGGED_OUT"];

/** May the ratio dialer place calls for this agent now? */
export function dialableNow(a: Pick<AgentLive, "dialAfter">, now = Date.now()): boolean {
  return !a.dialAfter || a.dialAfter <= now;
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
    if (patch.state === "READY") next.dialAfter = GRACE_FROM.includes(cur.state) ? next.since + READY_DIAL_GRACE_MS : null;
    else next.dialAfter = null;
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
