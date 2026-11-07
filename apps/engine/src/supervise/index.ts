// Supervision: listen, whisper (coach), barge, take over.
//
// A supervisor leg is a REST-created call to the supervisor's registered
// softphone, tagged kind=supervisor. When it is answered the call hook joins
// it to the agent's room: muted for listen, coach-to-agent for whisper,
// open for barge. Mode changes afterwards are participant actions on that
// leg, so the room is never interrupted. Take over is turned off (7 Nov):
// dropping the agent's leg ended the room and the customer with it.
import { prisma } from "@strowger/db";
import { getAgent } from "../agents/state";
import { config } from "../config";
import { hookUrl, jambonz, jambonzConfigured, roomOf } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToTenant } from "../realtime";

export type SuperviseMode = "LISTEN" | "WHISPER" | "BARGE";

export interface Supervision {
  tenantId: string;
  supervisorId: string;
  agentId: string;
  mode: SuperviseMode;
  callSid: string | null;
  callId: string | null;
  since: number;
}

const key = (supervisorId: string) => `supervise:${supervisorId}`;
/** Supervisors (and team leaders) listening to an agent: the live transcript goes to them too (assist/live.ts). */
const watchKey = (agentId: string) => `watchers:${agentId}`;

export async function watchersOf(agentId: string): Promise<string[]> {
  return redis.smembers(watchKey(agentId)).catch(() => []);
}

export async function getSupervision(supervisorId: string): Promise<Supervision | null> {
  const raw = await redis.get(key(supervisorId));
  return raw ? (JSON.parse(raw) as Supervision) : null;
}

async function save(s: Supervision): Promise<void> {
  await redis.set(key(s.supervisorId), JSON.stringify(s), "EX", 12 * 3600);
  await redis.sadd(watchKey(s.agentId), s.supervisorId);
  await redis.expire(watchKey(s.agentId), 12 * 3600);
  if (s.callSid) await redis.set(`supsid:${s.callSid}`, s.supervisorId, "EX", 12 * 3600);
  emitToTenant(s.tenantId, "floor:supervision", s);
}

async function audit(tenantId: string, actorId: string, action: string, target: string, after?: object): Promise<void> {
  await prisma.auditLog.create({ data: { tenantId, actorId, action, target, after } }).catch(() => undefined);
}

/** Ring the supervisor's softphone and join it to the agent's room in the given mode. */
export async function startSupervision(tenantId: string, supervisorId: string, agentId: string, mode: SuperviseMode): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!jambonzConfigured) return { ok: false, error: "Telephony is not configured" };
  const [sup, agent] = await Promise.all([prisma.user.findFirst({ where: { id: supervisorId, tenantId } }), getAgent(agentId)]);
  if (!sup?.sipUsername) return { ok: false, error: "You have no softphone line. Ask an admin to issue one on People." };
  if (!agent?.agentCallSid) return { ok: false, error: "That agent's line is not up" };

  const existing = await getSupervision(supervisorId);
  if (existing?.callSid) {
    if (existing.agentId === agentId) return setSupervisionMode(supervisorId, mode);
    await stopSupervision(supervisorId);
  }
  const s: Supervision = { tenantId, supervisorId, agentId, mode, callSid: null, callId: agent.currentCallId, since: Date.now() };
  await save(s);
  try {
    type CreateReq = Parameters<typeof jambonz.calls.create>[0];
    const from = (await prisma.callerIdNumber.findFirst({ where: { tenantId, status: "ACTIVE" } }))?.phone ?? "0000000000";
    const sid = await jambonz.calls.create({
      from: `+1${from}`,
      to: { type: "user", name: `${sup.sipUsername}@${config.JAMBONZ_SIP_REALM ?? ""}` },
      ...(config.JAMBONZ_APPLICATION_SID ? { application_sid: config.JAMBONZ_APPLICATION_SID } : { call_hook: { url: hookUrl("/jambonz/call"), method: "POST" }, call_status_hook: { url: hookUrl("/jambonz/status"), method: "POST" } }),
      timeout: 20,
      tag: { kind: "supervisor", supervisorId, agentId, mode, tenantId },
    } as CreateReq);
    await save({ ...s, callSid: sid });
    await audit(tenantId, supervisorId, `supervise.${mode.toLowerCase()}`, agentId);
    return { ok: true };
  } catch (e) {
    await redis.del(key(supervisorId));
    log.warn({ err: e }, "supervisor leg failed");
    return { ok: false, error: `Could not ring your line: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Verbs for the supervisor leg when jambonz answers it: into the agent's current line room. */
export async function supervisorJoinVerbs(s: Supervision): Promise<Record<string, unknown>[]> {
  const agent = await getAgent(s.agentId);
  if (!agent?.agentCallSid) return [{ verb: "hangup" }];
  return [
    {
      verb: "conference",
      name: roomOf(agent, s.agentId),
      memberTag: "supervisor",
      joinMuted: s.mode === "LISTEN",
      ...(s.mode === "WHISPER" ? { speakOnlyTo: "agent" } : {}),
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      beep: false,
      statusHook: hookUrl("/jambonz/conf", { supervisorId: s.supervisorId, tenantId: s.tenantId }),
      statusEvents: ["join", "leave", "end"],
    },
    { verb: "hangup" },
  ];
}

export async function setSupervisionMode(supervisorId: string, mode: SuperviseMode): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await getSupervision(supervisorId);
  if (!s?.callSid) return { ok: false, error: "Not supervising anyone" };
  try {
    if (mode === "LISTEN") {
      await jambonz.calls.update(s.callSid, { conferenceParticipantAction: { action: "uncoach" } }).catch(() => undefined);
      await jambonz.calls.update(s.callSid, { conf_mute_status: "mute" });
    } else if (mode === "WHISPER") {
      await jambonz.calls.update(s.callSid, { conferenceParticipantAction: { action: "coach", tag: "agent" } });
      await jambonz.calls.update(s.callSid, { conf_mute_status: "unmute" });
    } else {
      // Uncoach fails when the leg was never coached (listen → barge): barge must still unmute.
      await jambonz.calls.update(s.callSid, { conferenceParticipantAction: { action: "uncoach" } }).catch((e) => log.info({ err: e instanceof Error ? e.message : String(e), supervisorId }, "uncoach before barge failed"));
      await jambonz.calls.update(s.callSid, { conf_mute_status: "unmute" });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await save({ ...s, mode });
  await audit(s.tenantId, supervisorId, `supervise.${mode.toLowerCase()}`, s.agentId);
  return { ok: true };
}

/**
 * Take over is off (owner, 7 Nov): it hung up the agent's line, which ends the agent's room and so drops the
 * customer. Barge instead. Bringing it back needs the lead moved into the supervisor's own room first.
 */
export async function takeOver(supervisorId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  log.info({ supervisorId }, "take over refused: turned off");
  return { ok: false, error: "Take over is turned off for now; use Barge." };
}

/**
 * A lead joined the agent's room: re-send coach on every whispering supervisor of that agent, so the whisper
 * stays agent-only for the newcomer. Depends on conference join events (none logged since 6 Nov 22:10 UTC).
 */
export async function recoachWhisperers(agentId: string): Promise<void> {
  for (const supervisorId of await watchersOf(agentId)) {
    const s = await getSupervision(supervisorId);
    if (!s?.callSid || s.agentId !== agentId || s.mode !== "WHISPER") continue;
    await jambonz.calls.update(s.callSid, { conferenceParticipantAction: { action: "coach", tag: "agent" } }).catch((e) => log.warn({ err: e, supervisorId }, "re-coach failed"));
  }
}

export async function stopSupervision(supervisorId: string): Promise<void> {
  const s = await getSupervision(supervisorId);
  if (!s) return;
  if (s.callSid) await jambonz.calls.update(s.callSid, { call_status: "completed" }).catch(() => undefined);
  await redis.del(key(supervisorId));
  await redis.srem(watchKey(s.agentId), supervisorId);
  if (s.callSid) await redis.del(`supsid:${s.callSid}`);
  emitToTenant(s.tenantId, "floor:supervision", { ...s, callSid: null, mode: "LISTEN", ended: true });
  await audit(s.tenantId, supervisorId, "supervise.stop", s.agentId);
}

/** The supervisor leg ended on its own (status hook). */
export async function supervisorLegEnded(callSid: string): Promise<void> {
  const supervisorId = await redis.get(`supsid:${callSid}`);
  if (!supervisorId) return;
  const s = await getSupervision(supervisorId);
  if (s?.callSid === callSid) {
    await redis.del(key(supervisorId));
    await redis.srem(watchKey(s.agentId), supervisorId);
    emitToTenant(s.tenantId, "floor:supervision", { ...s, callSid: null, ended: true });
  }
  await redis.del(`supsid:${callSid}`);
}
