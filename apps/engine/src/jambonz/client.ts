// jambonz REST client, plus what we need to know to place calls.
import { JambonzClient } from "@jambonz/sdk/client";
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
