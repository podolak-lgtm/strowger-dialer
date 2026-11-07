// jambonz REST client, plus what we need to know to place calls.
import { JambonzClient } from "@jambonz/sdk/client";
import type { AgentLive } from "../agents/state";
import { config } from "../config";
import { log } from "../log";

export const jambonzConfigured = Boolean(config.JAMBONZ_API_KEY && config.JAMBONZ_ACCOUNT_SID);

export const jambonz = new JambonzClient({
  baseUrl: config.JAMBONZ_API_URL,
  accountSid: config.JAMBONZ_ACCOUNT_SID ?? "",
  apiKey: config.JAMBONZ_API_KEY ?? "",
});

if (!jambonzConfigured) log.warn("jambonz is not configured (JAMBONZ_API_KEY / JAMBONZ_ACCOUNT_SID): outbound dialing disabled");

export function hookUrl(path: string, params?: Record<string, string>): string {
  const u = new URL(path, config.ENGINE_PUBLIC_URL);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** The conference room that is an agent's nailed-up line. */
export function agentRoom(userId: string): string {
  return `agent-${userId}`;
}

/**
 * The room an agent's line sits in now: its own per-line room (`AgentLive.room`, `agent-<userId>-<sid8>`), or the
 * legacy `agent-<userId>` for a line that came up before per-line rooms. Every join into an agent's room uses this.
 */
export function roomOf(agent: Pick<AgentLive, "room"> | null | undefined, userId: string): string {
  return agent?.room ?? agentRoom(userId);
}

const ENDED = ["completed", "failed", "busy", "no-answer", "canceled", "cancelled"];

/**
 * Is this call leg still up at jambonz? A 404 / "not found" / "session is gone", or a final status, means gone.
 * Any other error (jambonz unreachable) counts as alive: the one-line rule refuses rather than doubles up.
 */
export async function callLegAlive(callSid: string): Promise<boolean> {
  try {
    const c = await jambonz.calls.get(callSid);
    return !ENDED.includes(String(c?.call_status ?? "").toLowerCase());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b404\b|not found|session is gone/i.test(msg)) return false;
    log.warn({ callSid, err: msg }, "could not tell whether a call leg is alive; treating it as alive");
    return true;
  }
}
