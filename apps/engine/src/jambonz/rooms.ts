// Leads in agents' rooms: the one conference verb every path uses to send a lead to an agent, and the
// conf-exit marker that keeps an engine-initiated move from being undone by the old room's exit hook.
//
// jambonz behaviour (6 Nov, HANDOFF "External transfers"): when the engine moves a lead leg out of a room (REST
// redirect, or a hook reply that replaces its verbs), jambonz still runs the old room's conference actionHook
// (`/jambonz/conf-exit`) about 0.2 s later, and THAT answer wins. So before every such move the engine writes
// `confexit:<callId>` = the verbs the lead must run next, and conf-exit answers with them instead of a hangup.
import type { AgentLive } from "../agents/state";
import { log } from "../log";
import { redis } from "../redis";
import { hookUrl, roomOf } from "./client";

type Verb = Record<string, unknown>;

const CONF_EXIT = (callId: string) => `confexit:${callId}`;
export const CONF_EXIT_TTL_SECONDS = 60;

interface ConfExitNext {
  /** The room the lead is leaving; the marker answers only that room's exit hook (null = any). */
  from: string | null;
  verbs: Verb[];
}

/** Write before moving a lead out of an agent's room. */
export async function setConfExitNext(callId: string, verbs: Verb[], from: string | null): Promise<void> {
  const v: ConfExitNext = { from, verbs };
  await redis.set(CONF_EXIT(callId), JSON.stringify(v), "EX", CONF_EXIT_TTL_SECONDS);
}

export async function clearConfExitNext(callId: string): Promise<void> {
  await redis.del(CONF_EXIT(callId));
}

async function readNext(callId: string): Promise<ConfExitNext | null> {
  const raw = await redis.get(CONF_EXIT(callId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConfExitNext;
  } catch {
    return null;
  }
}

/** The verbs waiting for a lead, left in place (the `/jambonz/moved` redirect target reads them). */
export async function peekConfExitNext(callId: string): Promise<Verb[] | null> {
  return (await readNext(callId))?.verbs ?? null;
}

/**
 * conf-exit for `room` (from its actionHook query; absent on hooks written before per-line rooms): the marker's
 * verbs, consumed, when it was written for this room.
 */
export async function takeConfExitNext(callId: string, room: string | undefined): Promise<Verb[] | null> {
  const next = await readNext(callId);
  if (!next) return null;
  if (next.from && room && next.from !== room) return null;
  await redis.del(CONF_EXIT(callId));
  return next.verbs;
}

/**
 * The conference verb that sends a lead into an agent's room: the agent's own per-line room (roomOf). The lead
 * cannot start the room; if it waits because the agent's room is not up, the waitHook (`/jambonz/conf-wait`) logs
 * it. The exit hook carries the room, so a conf-exit marker answers only the room it was written for.
 */
export function leadJoinVerb(o: { callId: string; tenantId: string; agentId: string; agent: AgentLive | null }): Verb {
  const room = roomOf(o.agent, o.agentId);
  log.info({ callId: o.callId, agentId: o.agentId, room, agentCallSid: o.agent?.agentCallSid ?? null }, "lead sent to agent room");
  return {
    verb: "conference",
    name: room,
    memberTag: "lead",
    startConferenceOnEnter: false,
    endConferenceOnExit: false,
    beep: false,
    statusHook: hookUrl("/jambonz/conf", { callId: o.callId, tenantId: o.tenantId }),
    statusEvents: ["join", "leave"],
    actionHook: hookUrl("/jambonz/conf-exit", { callId: o.callId, room }),
    waitHook: hookUrl("/jambonz/conf-wait", { callId: o.callId, room, agentId: o.agentId }),
  };
}
