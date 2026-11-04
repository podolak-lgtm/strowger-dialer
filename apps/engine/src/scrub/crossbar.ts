// Crossbar's scrub endpoint: our own DNC list there, the licensed TCPA
// Litigator List, the cache, then SubscriberVerify (paid) for the rest.
// POST {CROSSBAR_URL}/api/agent/scrub  Authorization: Bearer CROSSBAR_AGENT_KEY
// { phones: [...], paid?: boolean }  →  { ok, checked, flagged: [{phone, kind, source}], unresolved: [...] }
import { config } from "../config";

export type FlagKind = "LITIGATOR" | "DNC_COMPLAINER";

export interface ScrubOutcome {
  ok: true;
  checked: number;
  flagged: Array<{ phone: string; kind: FlagKind; source: string }>;
  unresolved: string[];
}

export interface ScrubFailure {
  ok: false;
  error: string;
  status?: number;
}

export const crossbarConfigured = Boolean(config.CROSSBAR_URL && config.CROSSBAR_AGENT_KEY);
export const SCRUB_BATCH = 2000;

export async function crossbarScrub(phones: string[], paid = config.SCRUB_PAID): Promise<ScrubOutcome | ScrubFailure> {
  if (!crossbarConfigured) return { ok: false, error: "Crossbar scrub is not configured (CROSSBAR_URL / CROSSBAR_AGENT_KEY)" };
  const url = new URL("/api/agent/scrub", config.CROSSBAR_URL).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.CROSSBAR_AGENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ phones: phones.slice(0, SCRUB_BATCH), paid }),
      signal: AbortSignal.timeout(280_000),
    });
  } catch (e) {
    return { ok: false, error: `Crossbar unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `Crossbar ${res.status}: ${text.slice(0, 200)}`, status: res.status };
  try {
    const body = JSON.parse(text) as Partial<ScrubOutcome> & { ok?: boolean; error?: string };
    if (!body.ok) return { ok: false, error: body.error ?? "Crossbar refused the scrub" };
    return {
      ok: true,
      checked: Number(body.checked ?? phones.length),
      flagged: (body.flagged ?? []).map((f) => ({ phone: String(f.phone), kind: f.kind === "DNC_COMPLAINER" ? "DNC_COMPLAINER" : "LITIGATOR", source: String(f.source ?? "") })),
      unresolved: (body.unresolved ?? []).map(String),
    };
  } catch {
    return { ok: false, error: "Crossbar returned something that is not JSON" };
  }
}
