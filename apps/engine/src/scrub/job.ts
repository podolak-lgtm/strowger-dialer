// Scrub leads that have not been checked yet. Runs on the scheduler and on
// demand from the Compliance page.
//
// A litigator hit blocks the lead (scrubStatus LITIGATOR, status BLOCKED). A
// do-not-call complainer blocks the lead too (scrubStatus DNC, status DNC)
// and is written to the tenant's system DNC list so the next upload of the
// same number is stopped at intake, with no lookup. Unresolved numbers stay
// PENDING and are asked again next run. Nothing here deletes a lead: the
// report and the audit trail need the row.
import { chargeScrub } from "../billing";
import { prisma } from "@strowger/db";
import { log } from "../log";
import { SCRUB_BATCH, crossbarConfigured, crossbarScrub } from "./crossbar";

export interface ScrubRunResult {
  tenantId: string;
  checked: number;
  litigators: number;
  complainers: number;
  unresolved: number;
  clean: number;
  error?: string;
}

export async function scrubPendingForTenant(tenantId: string, limit = SCRUB_BATCH): Promise<ScrubRunResult> {
  const out: ScrubRunResult = { tenantId, checked: 0, litigators: 0, complainers: 0, unresolved: 0, clean: 0 };
  const pending = await prisma.lead.findMany({
    where: { tenantId, scrubStatus: "PENDING", status: { notIn: ["DNC", "BLOCKED"] } },
    orderBy: { postedAt: "desc" },
    take: limit,
    select: { id: true, phone: true },
  });
  if (pending.length === 0) return out;

  if (!crossbarConfigured) {
    // No scrub source: record that fact on the lead instead of pretending it was checked.
    await prisma.lead.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { scrubStatus: "CLEAN", scrubReason: "No scrub source configured", scrubbedAt: new Date() } });
    out.clean = pending.length;
    return out;
  }

  const phones = [...new Set(pending.map((p) => p.phone))];
  const r = await crossbarScrub(phones);
  if (!r.ok) {
    out.error = r.error;
    log.warn({ tenantId, error: r.error }, "scrub failed");
    return out;
  }
  out.checked = r.checked;
  void chargeScrub(tenantId, r.checked).catch((e) => log.warn({ err: e }, "billing: scrub charge failed"));
  const now = new Date();
  const litig = r.flagged.filter((f) => f.kind === "LITIGATOR");
  const compl = r.flagged.filter((f) => f.kind === "DNC_COMPLAINER");
  const unresolved = new Set(r.unresolved);

  if (litig.length) {
    const byPhone = new Map(litig.map((f) => [f.phone, f.source]));
    for (const [phone, source] of byPhone) {
      await prisma.lead.updateMany({
        where: { tenantId, phone, scrubStatus: "PENDING" },
        data: { scrubStatus: "LITIGATOR", status: "BLOCKED", scrubReason: `Litigator (${source})`, scrubbedAt: now, nextDialAt: null, ownerId: null },
      });
    }
    out.litigators = byPhone.size;
  }
  if (compl.length) {
    const byPhone = new Map(compl.map((f) => [f.phone, f.source]));
    for (const [phone, source] of byPhone) {
      await prisma.lead.updateMany({
        where: { tenantId, phone, scrubStatus: "PENDING" },
        data: { scrubStatus: "DNC", status: "DNC", scrubReason: `Do-not-call complainer (${source})`, scrubbedAt: now, nextDialAt: null, ownerId: null },
      });
    }
    await prisma.dncEntry.createMany({ data: [...byPhone.keys()].map((phone) => ({ tenantId, phone, scope: "SYSTEM" as const, source: "CROSSBAR" as const, note: "DNC complainer per scrub" })), skipDuplicates: true });
    out.complainers = byPhone.size;
  }
  const flaggedPhones = new Set(r.flagged.map((f) => f.phone));
  const cleanIds = pending.filter((p) => !flaggedPhones.has(p.phone) && !unresolved.has(p.phone)).map((p) => p.id);
  if (cleanIds.length) {
    await prisma.lead.updateMany({ where: { id: { in: cleanIds } }, data: { scrubStatus: "CLEAN", scrubReason: null, scrubbedAt: now } });
  }
  out.clean = cleanIds.length;
  out.unresolved = pending.filter((p) => unresolved.has(p.phone)).length;

  const flaggedLeadIds = pending.filter((p) => flaggedPhones.has(p.phone)).map((p) => p.id);
  if (flaggedLeadIds.length) {
    await prisma.leadEvent.createMany({ data: flaggedLeadIds.map((leadId) => ({ tenantId, leadId, kind: "SCRUBBED" as const, data: { source: "crossbar", blocked: true } })) });
  }
  log.info(out, "scrub run");
  return out;
}

/** Every tenant with pending leads, one batch each. */
export async function scrubAllTenants(): Promise<ScrubRunResult[]> {
  const tenants = await prisma.lead.groupBy({ by: ["tenantId"], where: { scrubStatus: "PENDING", status: { notIn: ["DNC", "BLOCKED"] } }, _count: { _all: true } });
  const results: ScrubRunResult[] = [];
  for (const t of tenants) results.push(await scrubPendingForTenant(t.tenantId));
  return results;
}
