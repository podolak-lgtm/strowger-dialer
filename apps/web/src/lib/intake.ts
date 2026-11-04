// Taking a lead into a list: the one path uploads and the posting API share.
//
// Order of checks, and why:
//  1. normalise (bad phone is the commonest rejection, and cheap)
//  2. DNC: system scope, then the list's campaign scope. A DNC hit is stored
//     as a BLOCKED lead with the reason, never dropped, so the affiliate's
//     report and the audit trail both show it.
//  3. duplicate within the list, per the list's policy
//  4. timezone from ZIP, state, area code
// Litigator scrub (Crossbar/SubscriberVerify) runs afterwards as a job: it
// is slow and paid, and the lead must exist to carry the result.
import { prisma, type DuplicateAction, type Lead, type Prisma } from "@strowger/db";
import { missingPostFields, normalizeLead, resolveZone, type NormalizedLead } from "@strowger/shared";
import { engine } from "@/lib/engine";

export type IntakeSource = "POST" | "UPLOAD";

export type IntakeOutcome =
  | { status: "accepted"; leadId: string; timezone: string | null }
  | { status: "duplicate"; leadId: string; action: DuplicateAction }
  | { status: "rejected"; reason: "bad_phone" | "invalid" | "dnc" | "missing_fields" | "list_closed"; detail: string };

export interface IntakeContext {
  tenantId: string;
  listId: string;
  source: IntakeSource;
  /** Posting enforces the required field set; uploads only need a phone. */
  requireConsentFields: boolean;
  /** Who did it, for the LeadEvent. Null for the posting API. */
  actorId?: string | null;
  affiliateId?: string | null;
}

interface ListInfo {
  id: string;
  tenantId: string;
  campaignId: string | null;
  duplicateAction: DuplicateAction;
  status: string;
}

export async function loadList(tenantId: string, listId: string): Promise<ListInfo | null> {
  return prisma.list.findFirst({
    where: { id: listId, tenantId },
    select: { id: true, tenantId: true, campaignId: true, duplicateAction: true, status: true },
  });
}

export async function isOnDnc(tenantId: string, phone: string, campaignId: string | null): Promise<boolean> {
  const hit = await prisma.dncEntry.findFirst({
    where: {
      tenantId,
      phone,
      OR: [{ scope: "SYSTEM" }, ...(campaignId ? [{ scope: "CAMPAIGN" as const, campaignId }] : [])],
    },
    select: { id: true },
  });
  return Boolean(hit);
}

function leadData(lead: NormalizedLead, timezone: string | null, raw: unknown): Omit<Prisma.LeadUncheckedCreateInput, "tenantId" | "listId" | "phone"> {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
    email: lead.email,
    timezone,
    leadType: lead.leadType,
    consentJornayaId: lead.consentJornayaId,
    consentTrustedFormId: lead.consentTrustedFormId,
    optInUrl: lead.optInUrl,
    optInAt: lead.optInAt,
    optInIp: lead.optInIp,
    rawPayload: raw as Prisma.InputJsonValue,
    custom: lead.custom as Prisma.InputJsonValue,
  };
}

/** Take one lead into a list. `list` is passed in so a batch loads it once. */
export async function intakeLead(ctx: IntakeContext, list: ListInfo, raw: unknown): Promise<IntakeOutcome> {
  if (list.status === "ARCHIVED") return { status: "rejected", reason: "list_closed", detail: "List is archived" };

  const norm = normalizeLead(raw);
  if (!norm.ok) return { status: "rejected", reason: norm.reason, detail: norm.detail };
  const lead = norm.lead;

  if (ctx.requireConsentFields) {
    const missing = missingPostFields(lead);
    if (missing.length) return { status: "rejected", reason: "missing_fields", detail: `Missing: ${missing.join(", ")}` };
  }

  const zone = resolveZone({ zip: lead.zip, state: lead.state, phone: lead.phone });
  const timezone = zone?.timezone ?? null;
  const state = lead.state ?? zone?.state ?? null;
  const data = leadData({ ...lead, state }, timezone, raw);

  if (await isOnDnc(ctx.tenantId, lead.phone, list.campaignId)) {
    // Keep the record so the report shows it; it can never enter a hopper.
    await prisma.lead.upsert({
      where: { listId_phone: { listId: list.id, phone: lead.phone } },
      create: { ...data, tenantId: ctx.tenantId, listId: list.id, phone: lead.phone, status: "DNC", scrubStatus: "DNC", scrubReason: "On do-not-call list at intake", scrubbedAt: new Date() },
      update: {},
    });
    return { status: "rejected", reason: "dnc", detail: "Number is on the do-not-call list" };
  }

  const existing = await prisma.lead.findUnique({ where: { listId_phone: { listId: list.id, phone: lead.phone } } });
  if (existing) return handleDuplicate(ctx, list, existing, data);

  const created = await prisma.lead.create({
    data: { ...data, tenantId: ctx.tenantId, listId: list.id, phone: lead.phone, status: "NEW" },
  });
  await prisma.$transaction([
    prisma.leadEvent.create({
      data: { tenantId: ctx.tenantId, leadId: created.id, kind: ctx.source === "POST" ? "POSTED" : "IMPORTED", actorId: ctx.actorId ?? null, data: { source: ctx.source, affiliateId: ctx.affiliateId ?? null, zone } as unknown as Prisma.InputJsonValue },
    }),
    prisma.list.update({ where: { id: list.id }, data: { totalLeads: { increment: 1 }, dialableLeads: { increment: 1 } } }),
  ]);
  if (ctx.source === "POST") {
    // lead.created: the engine decides whether a cadence fires. Never block the poster on it.
    engine("/leads/posted", { method: "POST", body: JSON.stringify({ leadId: created.id }) }).catch(() => undefined);
  }
  return { status: "accepted", leadId: created.id, timezone };
}

async function handleDuplicate(
  ctx: IntakeContext,
  list: ListInfo,
  existing: Lead,
  data: ReturnType<typeof leadData>,
): Promise<IntakeOutcome> {
  const action = list.duplicateAction;
  if (action === "UPDATE") {
    await prisma.lead.update({
      where: { id: existing.id },
      data: {
        ...Object.fromEntries(Object.entries(data).filter(([k, v]) => v !== null && k !== "rawPayload")),
        rawPayload: data.rawPayload,
        postedAt: new Date(),
      },
    });
    await prisma.leadEvent.create({
      data: { tenantId: ctx.tenantId, leadId: existing.id, kind: "NOTE", actorId: ctx.actorId ?? null, data: { duplicate: "updated", source: ctx.source } },
    });
  } else if (action === "ACCEPT") {
    // Same phone, same list: the row is one lead, but it is treated as fresh
    // again, which is what "accept the duplicate" means for the hopper.
    await prisma.lead.update({ where: { id: existing.id }, data: { postedAt: new Date(), status: existing.status === "FINISHED" ? "NEW" : existing.status, nextDialAt: null } });
    await prisma.leadEvent.create({
      data: { tenantId: ctx.tenantId, leadId: existing.id, kind: "NOTE", actorId: ctx.actorId ?? null, data: { duplicate: "accepted", source: ctx.source } },
    });
  } else {
    await prisma.leadEvent.create({
      data: { tenantId: ctx.tenantId, leadId: existing.id, kind: "NOTE", actorId: ctx.actorId ?? null, data: { duplicate: "rejected", source: ctx.source } },
    });
  }
  return { status: "duplicate", leadId: existing.id, action };
}

// ── Bulk intake for uploads ──────────────────────────────────────────────────
//
// Same rules as intakeLead, done in sets: one DNC lookup, one existing-phone
// lookup, one insert of the new leads, one insert of their events, one
// counter update. Duplicates follow the list's policy (UPDATE is the only
// per-row write). Posting stays on intakeLead: one lead, one answer.

export interface BatchResult {
  accepted: number;
  duplicate: number;
  badPhone: number;
  dnc: number;
  invalid: number;
}

export async function intakeBatch(ctx: IntakeContext, list: ListInfo, rows: unknown[]): Promise<BatchResult> {
  const out: BatchResult = { accepted: 0, duplicate: 0, badPhone: 0, dnc: 0, invalid: 0 };
  if (list.status === "ARCHIVED" || rows.length === 0) return out;

  // 1. Normalise in memory; first occurrence of a phone within the file wins.
  const seen = new Set<string>();
  const good: Array<{ raw: unknown; lead: NormalizedLead; timezone: string | null; state: string | null; zone: ReturnType<typeof resolveZone> }> = [];
  for (const raw of rows) {
    const n = normalizeLead(raw);
    if (!n.ok) {
      if (n.reason === "bad_phone") out.badPhone++;
      else out.invalid++;
      continue;
    }
    if (seen.has(n.lead.phone)) {
      out.duplicate++;
      continue;
    }
    seen.add(n.lead.phone);
    const zone = resolveZone({ zip: n.lead.zip, state: n.lead.state, phone: n.lead.phone });
    good.push({ raw, lead: n.lead, timezone: zone?.timezone ?? null, state: n.lead.state ?? zone?.state ?? null, zone });
  }
  if (good.length === 0) return out;
  const phones = good.map((g) => g.lead.phone);

  // 2. One DNC lookup and one existing-lead lookup for the whole set.
  const [dncRows, existingRows] = await Promise.all([
    prisma.dncEntry.findMany({ where: { tenantId: ctx.tenantId, phone: { in: phones }, OR: [{ scope: "SYSTEM" }, ...(list.campaignId ? [{ scope: "CAMPAIGN" as const, campaignId: list.campaignId }] : [])] }, select: { phone: true } }),
    prisma.lead.findMany({ where: { listId: list.id, phone: { in: phones } }, select: { id: true, phone: true, status: true } }),
  ]);
  const dnc = new Set(dncRows.map((d) => d.phone));
  const existing = new Map(existingRows.map((e) => [e.phone, e]));

  const now = new Date();
  const creates: Prisma.LeadCreateManyInput[] = [];
  const updates: Array<{ id: string; data: Prisma.LeadUpdateInput }> = [];
  const touched: string[] = []; // existing ids that get a duplicate event

  for (const g of good) {
    const data = leadData({ ...g.lead, state: g.state }, g.timezone, g.raw);
    const ex = existing.get(g.lead.phone);
    if (dnc.has(g.lead.phone)) {
      out.dnc++;
      if (!ex) creates.push({ ...data, tenantId: ctx.tenantId, listId: list.id, phone: g.lead.phone, status: "DNC", scrubStatus: "DNC", scrubReason: "On do-not-call list at intake", scrubbedAt: now } as Prisma.LeadCreateManyInput);
      continue;
    }
    if (ex) {
      out.duplicate++;
      touched.push(ex.id);
      if (list.duplicateAction === "UPDATE") {
        updates.push({ id: ex.id, data: { ...Object.fromEntries(Object.entries(data).filter(([k, v]) => v !== null && k !== "rawPayload")), rawPayload: data.rawPayload, postedAt: now } as Prisma.LeadUpdateInput });
      } else if (list.duplicateAction === "ACCEPT") {
        updates.push({ id: ex.id, data: { postedAt: now, nextDialAt: null, ...(ex.status === "FINISHED" ? { status: "NEW" } : {}) } });
      }
      continue;
    }
    creates.push({ ...data, tenantId: ctx.tenantId, listId: list.id, phone: g.lead.phone, status: "NEW" } as Prisma.LeadCreateManyInput);
  }

  // 3. Bulk writes.
  if (creates.length) await prisma.lead.createMany({ data: creates, skipDuplicates: true });
  const created = creates.length ? await prisma.lead.findMany({ where: { listId: list.id, phone: { in: creates.map((c) => c.phone) } }, select: { id: true, status: true } }) : [];
  const newLive = created.filter((c) => c.status !== "DNC");
  out.accepted = newLive.length;
  await prisma.$transaction([
    ...(created.length
      ? [prisma.leadEvent.createMany({ data: created.map((c) => ({ tenantId: ctx.tenantId, leadId: c.id, kind: "IMPORTED" as const, actorId: ctx.actorId ?? null, data: { source: ctx.source } })) })]
      : []),
    ...(touched.length ? [prisma.leadEvent.createMany({ data: touched.map((id) => ({ tenantId: ctx.tenantId, leadId: id, kind: "NOTE" as const, actorId: ctx.actorId ?? null, data: { duplicate: list.duplicateAction.toLowerCase(), source: ctx.source } })) })] : []),
    ...updates.map((u) => prisma.lead.update({ where: { id: u.id }, data: u.data })),
    ...(created.length ? [prisma.list.update({ where: { id: list.id }, data: { totalLeads: { increment: created.length }, dialableLeads: { increment: newLive.length } } })] : []),
  ]);
  return out;
}
