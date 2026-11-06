// One number, checked everywhere the dialer would stop it (owner, 6 Nov:
// "check this number and tell me if it's on the DNC or litigator list").
// Our own do-not-call list (system and campaign), any lead with that number
// and its scrub status, then Crossbar's scrub (their DNC, the licensed TCPA
// Litigator List, the cache, and SubscriberVerify when paid). The engine holds
// the Crossbar key, so nobody needs it in a browser or a chat.
import { prisma } from "@strowger/db";
import { normalizePhone } from "@strowger/shared/phone";
import { chargeScrub } from "../billing";
import { log } from "../log";
import { crossbarConfigured, crossbarScrub } from "./crossbar";

export interface NumberCheck {
  phone: string;
  ourDnc: Array<{ scope: string; campaign: string | null; source: string; note: string | null; addedAt: string }>;
  leads: Array<{ id: string; name: string; status: string; scrubStatus: string; list: string | null }>;
  crossbar:
    | { checked: true; paid: boolean; flagged: Array<{ kind: string; source: string }>; unresolved: boolean }
    | { checked: false; error: string };
  /** One line: may the dialer call it? */
  verdict: "BLOCKED" | "CLEAR" | "UNKNOWN";
  reasons: string[];
}

export async function checkNumber(tenantId: string, raw: string, paid: boolean): Promise<{ ok: true; result: NumberCheck } | { ok: false; error: string }> {
  const phone = normalizePhone(raw);
  if (!phone) return { ok: false, error: "That is not a US phone number." };

  const [dnc, leads] = await Promise.all([
    prisma.dncEntry.findMany({ where: { tenantId, phone }, include: { campaign: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.lead.findMany({ where: { tenantId, phone }, select: { id: true, firstName: true, lastName: true, status: true, scrubStatus: true, list: { select: { name: true } } }, orderBy: { postedAt: "desc" }, take: 10 }),
  ]);

  let crossbar: NumberCheck["crossbar"];
  if (!crossbarConfigured) crossbar = { checked: false, error: "Crossbar scrub is not configured on the engine." };
  else {
    const r = await crossbarScrub([phone], paid);
    if (!r.ok) crossbar = { checked: false, error: r.error };
    else {
      crossbar = { checked: true, paid, flagged: r.flagged.filter((f) => f.phone.endsWith(phone)).map((f) => ({ kind: f.kind, source: f.source })), unresolved: r.unresolved.some((u) => u.endsWith(phone)) };
      if (paid) await chargeScrub(tenantId, 1).catch((e) => log.warn({ err: e }, "single-number check: scrub charge failed"));
    }
  }

  const reasons: string[] = [];
  for (const d of dnc) reasons.push(d.scope === "CAMPAIGN" ? `On the do-not-call list for campaign ${d.campaign?.name ?? "?"}` : "On your workspace do-not-call list");
  if (crossbar.checked) for (const f of crossbar.flagged) reasons.push(f.kind === "LITIGATOR" ? `TCPA litigator (${f.source})` : `Do-not-call complainer (${f.source})`);
  for (const l of leads) if (l.scrubStatus === "LITIGATOR" || l.scrubStatus === "DNC") reasons.push(`Lead ${[l.firstName, l.lastName].filter(Boolean).join(" ") || l.id} is scrubbed as ${l.scrubStatus.toLowerCase()}`);

  const verdict: NumberCheck["verdict"] = reasons.length ? "BLOCKED" : crossbar.checked && !crossbar.unresolved ? "CLEAR" : "UNKNOWN";
  return {
    ok: true,
    result: {
      phone,
      ourDnc: dnc.map((d) => ({ scope: d.scope, campaign: d.campaign?.name ?? null, source: d.source, note: d.note, addedAt: d.createdAt.toISOString() })),
      leads: leads.map((l) => ({ id: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", status: l.status, scrubStatus: l.scrubStatus, list: l.list?.name ?? null })),
      crossbar,
      verdict,
      reasons,
    },
  };
}
