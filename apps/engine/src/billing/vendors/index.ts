// Vendor connectors: one per vendor (API where the vendor has one, a signed-in
// browser where it does not), a "Collect now" button and a nightly switch each
// on /platform → Balances, and the nightly run (owner, 6 Nov: "in a perfect
// world, at night you log in and get everything updated").
//
// A connector only reads. Everything it finds is written here, through the one
// cost model: balances and the vendor's own month figure into VendorAccount,
// running month totals into VendorUsage (period:<YYYY-MM>:<part>, source api,
// replaced on every run), invoices through invoice.ts. Re-runs never add twice.
import { prisma } from "@strowger/db";
import { invoiceMode, monthRowCounts, nightlySummary, periodKey, secretHint, sniffInvoiceFile, type RunOutcome } from "@strowger/shared/vendor-collect";
import { config } from "../../config";
import { emailWorkspace } from "../../email";
import { log } from "../../log";
import { redis } from "../../redis";
import { keepUsage, materialiseFixedCosts, monthClasses, noteError, periodRowsWhere, synced, vendorAccounts } from "../vendor";
import { anthropic } from "./anthropic";
import { cartesia } from "./cartesia";
import { clerk } from "./clerk";
import { deepgram } from "./deepgram";
import { applyInvoice, invoiceReadingConfigured, recentInvoices } from "./invoice";
import { jambonz } from "./jambonz";
import { railway } from "./railway";
import { secretsConfigured, seal, unseal } from "./secrets";
import { bucketConfigured } from "./storage";
import { telnyx } from "./telnyx";
import { NeedsPerson, type CollectResult, type Connector } from "./types";
import { vercel } from "./vercel";

export const CONNECTORS: Connector[] = [telnyx, railway, vercel, deepgram, anthropic, cartesia, jambonz, clerk];
export const connector = (vendor: string) => CONNECTORS.find((c) => c.vendor === vendor);

// ---- Credentials

async function savedValues(vendor: string): Promise<Record<string, string>> {
  const row = await prisma.vendorConnection.findUnique({ where: { vendor } });
  return unseal(row?.sealed);
}

/** Saved values, with each field's env fallback where nothing is saved. */
async function credentialsFor(c: Connector): Promise<Record<string, string>> {
  const saved = await savedValues(c.vendor);
  const env = config as unknown as Record<string, string | undefined>;
  const out: Record<string, string> = {};
  for (const f of c.credentials) {
    const v = saved[f.key] ?? (f.env ? env[f.env] : undefined);
    if (v) out[f.key] = v;
  }
  return out;
}

export interface Actor {
  tenantId: string;
  userId: string | null;
}

const audit = (actor: Actor, action: string, target: string, after: object) => prisma.auditLog.create({ data: { tenantId: actor.tenantId, actorId: actor.userId, action, target, after } }).catch((e) => log.warn({ err: e }, "vendor audit log failed"));

/**
 * Save a vendor's credentials. A field left blank keeps what is saved; a field named in `clear` is removed. The
 * values are sealed; the audit log records which fields changed, never their values.
 */
export async function saveConnection(vendor: string, values: Record<string, string>, clear: string[], actor: Actor): Promise<void> {
  const c = connector(vendor);
  if (!c) throw new Error(`Unknown vendor ${vendor}`);
  if (!secretsConfigured) throw new Error("VENDOR_SECRETS_KEY is not set on the engine, so credentials cannot be saved");
  const known = new Set(c.credentials.map((f) => f.key));
  const current = await savedValues(vendor);
  const changed: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!known.has(k) || !v.trim()) continue;
    current[k] = v.trim();
    changed.push(k);
  }
  for (const k of clear) {
    if (known.has(k) && k in current) {
      delete current[k];
      changed.push(k);
    }
  }
  if (!changed.length) return;
  const hints: Record<string, string> = {};
  for (const f of c.credentials) if (current[f.key]) hints[f.key] = f.secret ? secretHint(current[f.key])! : current[f.key]!;
  const sealed = Object.keys(current).length ? seal(current) : null;
  await prisma.vendorConnection.upsert({ where: { vendor }, create: { vendor, sealed, hints, updatedById: actor.userId }, update: { sealed, hints, updatedById: actor.userId } });
  await audit(actor, "vendor.credentials", vendor, { fields: [...new Set(changed)].sort() });
}

export async function setNightly(vendor: string, nightly: boolean, actor: Actor): Promise<void> {
  if (!connector(vendor)) throw new Error(`Unknown vendor ${vendor}`);
  await prisma.vendorConnection.upsert({ where: { vendor }, create: { vendor, nightly, updatedById: actor.userId }, update: { nightly, updatedById: actor.userId } });
  await audit(actor, "vendor.nightly", vendor, { nightly });
}

// ---- Live progress (Redis, a day)

export interface Progress {
  state: "running" | "done" | "failed" | "needs_person";
  step: string;
  log: { at: string; line: string }[];
  startedAt: string;
  finishedAt?: string;
}
const progressKey = (vendor: string) => `vendorcollect:${vendor}`;
async function progress(vendor: string): Promise<Progress | null> {
  const raw = await redis.get(progressKey(vendor));
  return raw ? (JSON.parse(raw) as Progress) : null;
}
async function note(vendor: string, p: Progress, step: string, line: string): Promise<void> {
  p.step = step;
  p.log.push({ at: new Date().toISOString(), line });
  if (p.log.length > 40) p.log.splice(0, p.log.length - 40);
  await redis.set(progressKey(vendor), JSON.stringify(p), "EX", 86_400);
}

/** The card's view: no saved value ever leaves the engine, only hints. */
export async function listConnections() {
  const [rows, accounts, invoices] = await Promise.all([prisma.vendorConnection.findMany(), vendorAccounts(), recentInvoices()]);
  const env = config as unknown as Record<string, string | undefined>;
  const out = [];
  for (const c of CONNECTORS) {
    const row = rows.find((r) => r.vendor === c.vendor);
    const hints = (row?.hints ?? {}) as Record<string, string>;
    let missing: string | null;
    try {
      missing = c.missing(await credentialsFor(c));
    } catch (e) {
      missing = e instanceof Error ? e.message : String(e);
    }
    const a = accounts.find((x) => x.vendor === c.vendor);
    out.push({
      vendor: c.vendor,
      label: c.label,
      method: c.method,
      collects: c.collects,
      whereToGet: c.whereToGet,
      fields: c.credentials.map((f) => ({ key: f.key, label: f.label, secret: f.secret, optional: Boolean(f.optional), hint: hints[f.key] ?? (f.env && env[f.env] ? `from ${f.env}` : null) })),
      missing,
      nightly: row?.nightly ?? false,
      lastStatus: row?.lastStatus ?? null,
      lastError: row?.lastError ?? null,
      lastRunAt: row?.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
      lastScreenshotKey: row?.lastScreenshotKey ?? null,
      progress: await progress(c.vendor),
      invoiceMode: invoiceMode(c.vendor),
      balanceCents: a?.balanceCents ?? null,
      lowBalanceCents: a?.lowBalanceCents ?? null,
    });
  }
  return { secretsConfigured, invoiceReadingConfigured, bucketConfigured, connectors: out, invoices };
}

// ---- Running a connector

/** Running month totals: replaced whole for each month the connector reported, unless an invoice is in for it. */
async function writePeriodRows(vendor: string, r: CollectResult): Promise<void> {
  const periods = new Set([...(r.periods ?? []), ...(r.rows ?? []).map((x) => x.period)]);
  for (const period of periods) {
    if (!monthRowCounts(vendor, "period", await monthClasses(vendor, period))) {
      await prisma.vendorUsage.deleteMany({ where: periodRowsWhere(vendor, period) });
      continue;
    }
    const keys: string[] = [];
    for (const row of (r.rows ?? []).filter((x) => x.period === period)) {
      const recordId = periodKey(period, row.part);
      keys.push(recordId);
      await keepUsage({ vendor, kind: row.kind, recordId, millicents: row.millicents, day: `${period}-01`, tenantId: row.tenantId ?? null, quantity: row.quantity ?? 1, source: "api", replace: true });
    }
    await prisma.vendorUsage.deleteMany({ where: { vendor, source: "api", vendorRecordId: { startsWith: `period:${period}:`, notIn: keys } } });
  }
}

export async function runConnector(vendor: string, onStep: (step: string, line: string) => Promise<void> = async () => undefined): Promise<RunOutcome> {
  const c = connector(vendor);
  if (!c) return { vendor, label: vendor, status: "failed", error: "Unknown vendor" };
  const startedAt = new Date();
  let screenshot: string | null = null;
  await prisma.vendorConnection.upsert({ where: { vendor }, create: { vendor, lastStatus: "running", lastRunAt: startedAt }, update: { lastStatus: "running", lastRunAt: startedAt } });
  try {
    const creds = await credentialsFor(c);
    const missing = c.missing(creds);
    if (missing) throw new Error(missing);
    const r = await c.collect({ now: startedAt, creds, step: onStep, screenshot: (k) => (screenshot = k) });
    await onStep("reading", "Writing what was found");
    const account: Record<string, unknown> = { usageSyncedAt: new Date() };
    if (r.balanceCents !== undefined && r.balanceCents !== null) Object.assign(account, { balanceCents: r.balanceCents, balanceSource: c.method === "api" ? "api" : "portal", balanceAt: new Date() });
    if (r.reported) Object.assign(account, { reportedPeriod: r.reported.period, reportedCents: r.reported.cents, reportedAt: new Date() });
    if (r.note !== undefined) account.note = r.note;
    await synced(vendor, account);
    await writePeriodRows(vendor, r);
    const problems: string[] = [];
    for (const [i, inv] of (r.invoices ?? []).entries()) {
      await onStep("reading", `Reading invoice ${i + 1} of ${r.invoices!.length}${inv.file && !inv.lines ? " with Claude" : ""}`);
      try {
        const a = await applyInvoice(vendor, inv, c.method === "api" ? "api" : "browser");
        if (a.warning) problems.push(a.warning);
      } catch (e) {
        problems.push(`invoice ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await materialiseFixedCosts();
    const error = problems.length ? problems.join("; ").slice(0, 400) : null;
    await prisma.vendorConnection.update({ where: { vendor }, data: { lastStatus: "ok", lastError: error, lastSuccessAt: new Date(), lastScreenshotKey: null } });
    return { vendor, label: c.label, status: "ok", error };
  } catch (e) {
    const needs = e instanceof NeedsPerson;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    await prisma.vendorConnection.update({ where: { vendor }, data: { lastStatus: needs ? "needs_person" : "failed", lastError: msg, lastScreenshotKey: screenshot } }).catch(() => undefined);
    await noteError(vendor, e);
    return { vendor, label: c.label, status: needs ? "needs_person" : "failed", error: msg };
  }
}

/** "Collect now": runs in the background; the card polls the progress. Refuses while a run for the vendor is going. */
export async function startCollect(vendor: string, actor: Actor | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!connector(vendor)) return { ok: false, error: `Unknown vendor ${vendor}` };
  const cur = await progress(vendor);
  if (cur?.state === "running" && Date.now() - new Date(cur.startedAt).getTime() < 15 * 60_000) return { ok: false, error: "A collection for this vendor is already running" };
  const p: Progress = { state: "running", step: "starting", log: [], startedAt: new Date().toISOString() };
  await note(vendor, p, "starting", "Starting");
  if (actor) await audit(actor, "vendor.collect", vendor, {});
  void runConnector(vendor, (step, line) => note(vendor, p, step, line)).then(async (r) => {
    p.state = r.status === "ok" ? "done" : r.status === "needs_person" ? "needs_person" : "failed";
    p.finishedAt = new Date().toISOString();
    await note(vendor, p, p.state, r.status === "ok" ? `Done${r.error ? ` (with warnings: ${r.error})` : ""}` : r.status === "needs_person" ? `Needs a person: ${r.error}` : `Failed: ${r.error}`);
  });
  return { ok: true };
}

/** "Upload invoice": a PDF or CSV the owner drops on a vendor's row. */
export async function uploadInvoice(vendor: string, name: string, contentType: string | null, bytes: Buffer, actor: Actor) {
  if (!connector(vendor) && !/^[a-z0-9-]{2,40}$/.test(vendor)) throw new Error("Pick the vendor the invoice is from");
  const type = sniffInvoiceFile(name, contentType, bytes.subarray(0, 4096));
  if (!type) throw new Error("Upload a PDF invoice or a CSV usage export");
  const month = /(20\d\d)[-_.]?(0[1-9]|1[0-2])/.exec(name);
  const r = await applyInvoice(vendor, { file: { bytes, type }, period: month ? `${month[1]}-${month[2]}` : null }, "upload");
  await audit(actor, "vendor.invoice-upload", vendor, { period: r.period, ref: r.ref, totalCents: r.totalCents, counted: r.counted });
  return r;
}

// ---- The nightly run (scheduler: first tick at or after 07:00 UTC, 2-3 a.m. US Eastern)

export async function runNightly(): Promise<RunOutcome[]> {
  const enabled = await prisma.vendorConnection.findMany({ where: { nightly: true }, select: { vendor: true } });
  const runs: RunOutcome[] = [];
  // One after another: browsers are heavy, and a vendor that fails does not stop the others.
  for (const c of CONNECTORS.filter((x) => enabled.some((e) => e.vendor === x.vendor))) {
    const p: Progress = { state: "running", step: "starting", log: [], startedAt: new Date().toISOString() };
    await note(c.vendor, p, "starting", "Nightly collection");
    const r = await runConnector(c.vendor, (step, line) => note(c.vendor, p, step, line));
    p.state = r.status === "ok" ? "done" : r.status === "needs_person" ? "needs_person" : "failed";
    p.finishedAt = new Date().toISOString();
    await note(c.vendor, p, p.state, r.status === "ok" ? "Done (nightly)" : `${r.status === "needs_person" ? "Needs a person" : "Failed"}: ${r.error}`);
    runs.push(r);
  }
  const accounts = await vendorAccounts();
  const summary = nightlySummary(
    runs,
    accounts.map((a) => ({ label: a.label, balanceCents: a.balanceCents, lowBalanceCents: a.lowBalanceCents })),
  );
  log.info({ runs: runs.map((r) => `${r.vendor}:${r.status}`), emailed: Boolean(summary) }, "vendor nightly collection");
  if (summary) {
    const platform = await prisma.tenant.findFirst({ where: { isPlatform: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (platform) await emailWorkspace(platform.id, { subject: summary.subject, title: "Vendor costs: last night's collection", paragraphs: [...summary.lines, "Open Platform → Balances for the details and a screenshot of any page that failed."], button: { label: "Open Balances", path: "/platform?tab=balances" } }, `vendor-nightly:${new Date().toISOString().slice(0, 10)}`, 2 * 86_400);
  }
  return runs;
}
