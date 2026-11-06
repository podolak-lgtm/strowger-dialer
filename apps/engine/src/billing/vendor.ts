// What vendors actually charge us (owner, 5 Nov: "get the pricing in via the
// API on everything"; 6 Nov: "make sure all the APIs are grabbing everything").
// One cost model: every cost lands in VendorUsage with vendor, kind, quantity,
// cost in millicents, day, the client it belongs to when known, and its source:
//
//   api       pulled from the vendor's records (Telnyx detail records, the jambonz invoice)
//   usage     counted per event × a list price or rate (AI tokens, speech minutes, TTS characters, numbers, scrubs)
//   estimate  our rate for a call or text until Telnyx's record is matched, then deleted
//   fixed     a monthly cost entered on /platform (Railway, Clerk, the jambonz plan…)
//
// Every pull is keyed by (vendor, vendorRecordId), so re-runs never double count.
// Balances and the vendors' own month totals live in VendorAccount.
import { prisma } from "@strowger/db";
import { periodsCovered } from "@strowger/shared/accounting";
import { config } from "../config";
import { log } from "../log";
import { redis } from "../redis";
import { rates } from "./index";

const TELNYX = config.TELNYX_API_URL.replace(/\/+$/, "");
const dollarsToMillicents = (v: unknown) => Math.round(Number(v ?? 0) * 100_000);
const today = () => new Date().toISOString().slice(0, 10);
const thisPeriod = () => new Date().toISOString().slice(0, 7);
const dayOf = (iso: string | undefined) => (iso ? iso.slice(0, 10) : today());
const toCents = (mc: number) => Math.round(mc / 1000);

// ---- Writing usage

export interface UsageInput {
  vendor: string;
  kind: string;
  /** Vendor record id, or our own idempotency key. Null = an event with no natural key (one row per event). */
  recordId?: string | null;
  millicents: number;
  day?: string;
  tenantId?: string | null;
  refId?: string | null;
  quantity?: number;
  source: "api" | "usage" | "estimate" | "fixed";
  /** Overwrite an existing row with the same key (fixed costs, monthly reports); default = keep the first. */
  replace?: boolean;
}

/** One cost row. Returns false when the key was already there (nothing counted twice). */
export async function keepUsage(u: UsageInput): Promise<boolean> {
  const millicents = Math.round(u.millicents);
  const data = { vendor: u.vendor, kind: u.kind, costCents: toCents(millicents), costMillicents: millicents, day: u.day ?? today(), tenantId: u.tenantId ?? null, refId: u.refId ?? null, quantity: u.quantity ?? 1, source: u.source };
  if (!u.recordId) {
    await prisma.vendorUsage.create({ data });
    return true;
  }
  const key = { vendor_vendorRecordId: { vendor: u.vendor, vendorRecordId: u.recordId } };
  if (u.replace) {
    await prisma.vendorUsage.upsert({ where: key, create: { ...data, vendorRecordId: u.recordId }, update: data });
    return true;
  }
  if (await prisma.vendorUsage.findUnique({ where: key, select: { id: true } })) return false;
  try {
    await prisma.vendorUsage.create({ data: { ...data, vendorRecordId: u.recordId } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false; // another run wrote it first
    throw e;
  }
}

/** A call's carrier cost at our rate until the Telnyx record arrives (pullTelnyxCalls deletes it then). */
export async function estimateCallCost(callId: string, tenantId: string, minutes: number, millicents: number): Promise<void> {
  await keepUsage({ vendor: "telnyx", kind: "sip-trunking", recordId: `est:call:${callId}`, millicents, tenantId, refId: callId, quantity: minutes, source: "estimate" }).catch((e) => log.warn({ err: e }, "call cost estimate failed"));
}

export async function estimateMessageCost(messageId: string, tenantId: string, segments: number, millicents: number): Promise<void> {
  await keepUsage({ vendor: "telnyx", kind: "messaging", recordId: `est:msg:${messageId}`, millicents, tenantId, refId: messageId, quantity: segments, source: "estimate" }).catch((e) => log.warn({ err: e }, "text cost estimate failed"));
}

async function vendorAccount(vendor: string) {
  return prisma.vendorAccount.upsert({ where: { vendor }, create: { vendor }, update: {} });
}

async function noteError(vendor: string, e: unknown): Promise<void> {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  await prisma.vendorAccount.upsert({ where: { vendor }, create: { vendor, lastError: msg, lastErrorAt: new Date() }, update: { lastError: msg, lastErrorAt: new Date() } }).catch(() => undefined);
  log.warn({ vendor, err: msg }, "vendor sync failed");
}

const synced = (vendor: string, data: Record<string, unknown>) => prisma.vendorAccount.upsert({ where: { vendor }, create: { vendor, ...data, lastError: null, lastErrorAt: null }, update: { ...data, lastError: null, lastErrorAt: null } });

// ---- Telnyx: detail records (calls, texts, the per-record extras) and the balance

async function telnyxGet<T>(path: string, query: Record<string, string>): Promise<T> {
  if (!config.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not set");
  const u = new URL(TELNYX + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { authorization: `Bearer ${config.TELNYX_API_KEY}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Telnyx ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

type Page<T> = { data: T[]; meta?: { total_pages?: number; page_number?: number } };

/** Every detail record of a type for a date range, all pages. */
async function detailRecords<T>(recordType: string, dateRange: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page++) {
    const r = await telnyxGet<Page<T>>("/detail_records", { "filter[record_type]": recordType, "filter[date_range]": dateRange, "page[size]": "50", "page[number]": String(page) });
    out.push(...r.data);
    if (!r.meta?.total_pages || page >= r.meta.total_pages) break;
  }
  return out;
}

interface Cdr {
  id?: string;
  uuid?: string;
  record_type?: string;
  cli?: string;
  cld?: string;
  direction?: string;
  started_at?: string;
  ended_at?: string;
  call_sec?: number;
  billed_sec?: number;
  cost?: string | number;
  currency?: string;
  call_leg_id?: string;
}
interface Mdr {
  uuid?: string;
  id?: string;
  cli?: string;
  cld?: string;
  direction?: string;
  created_at?: string;
  cost?: string | number;
  carrier_fee?: string | number;
  parts?: number;
}

/** Attach the carrier's real cost to the Call and its MINUTES entry; the estimate row goes. */
async function applyCallCost(callId: string, tenantId: string, millicents: number, recordId: string): Promise<void> {
  const costCents = toCents(millicents);
  await prisma.call.update({ where: { id: callId }, data: { vendorCostCents: costCents, vendorRecordId: recordId } });
  await prisma.billingEntry.updateMany({ where: { tenantId, category: "MINUTES", refId: callId }, data: { costCents, costSource: "telnyx" } });
  await prisma.vendorUsage.deleteMany({ where: { vendor: "telnyx", vendorRecordId: `est:call:${callId}` } });
}

/** Calls: match by direction, the far-end number and a start time within three minutes. A transfer's destination leg is outbound at the carrier. */
export async function pullTelnyxCalls(dateRange = "last_3_days"): Promise<{ records: number; matched: number; costCents: number }> {
  const cdrs = await detailRecords<Cdr>("sip-trunking", dateRange);
  let matched = 0;
  let mc = 0;
  for (const r of cdrs) {
    const id = r.id ?? r.uuid ?? r.call_leg_id ?? null;
    if (id && (await prisma.vendorUsage.findUnique({ where: { vendor_vendorRecordId: { vendor: "telnyx", vendorRecordId: id } }, select: { id: true } }))) continue;
    const cost = dollarsToMillicents(r.cost);
    const dir = (r.direction ?? "").toLowerCase().startsWith("in") ? "INBOUND" : "OUTBOUND";
    const far = dir === "OUTBOUND" ? r.cld : r.cli;
    const started = r.started_at ? new Date(r.started_at) : null;
    let call: { id: string; tenantId: string } | null = null;
    if (far && started) {
      const digits = far.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
      call = await prisma.call.findFirst({
        where: { direction: dir === "INBOUND" ? "INBOUND" : { in: ["OUTBOUND", "MANUAL", "TRANSFER"] }, phone: digits, vendorRecordId: null, dialedAt: { gte: new Date(started.getTime() - 180_000), lte: new Date(started.getTime() + 180_000) } },
        orderBy: { dialedAt: "asc" },
        select: { id: true, tenantId: true },
      });
    }
    const fresh = await keepUsage({ vendor: "telnyx", kind: "sip-trunking", recordId: id, millicents: cost, day: dayOf(r.started_at), tenantId: call?.tenantId, refId: call?.id, quantity: (r.billed_sec ?? r.call_sec ?? 0) / 60, source: "api" });
    if (!fresh) continue;
    mc += cost;
    if (call) {
      await applyCallCost(call.id, call.tenantId, cost, id ?? "");
      matched++;
    }
  }
  return { records: cdrs.length, matched, costCents: toCents(mc) };
}

/** Texts: the message id Telnyx gave us at send time is the detail record's uuid. */
export async function pullTelnyxMessages(dateRange = "last_3_days"): Promise<{ records: number; matched: number; costCents: number }> {
  const mdrs = await detailRecords<Mdr>("messaging", dateRange);
  let matched = 0;
  let mc = 0;
  for (const r of mdrs) {
    const id = r.uuid ?? r.id ?? null;
    const cost = dollarsToMillicents(r.cost) + dollarsToMillicents(r.carrier_fee);
    const msg = id ? await prisma.message.findFirst({ where: { providerMessageId: id }, select: { id: true, tenantId: true } }) : null;
    const fresh = await keepUsage({ vendor: "telnyx", kind: "messaging", recordId: id, millicents: cost, day: dayOf(r.created_at), tenantId: msg?.tenantId, refId: msg?.id, quantity: r.parts ?? 1, source: "api" });
    if (!fresh) continue;
    mc += cost;
    if (msg) {
      await prisma.message.update({ where: { id: msg.id }, data: { vendorCostCents: toCents(cost) } });
      await prisma.billingEntry.updateMany({ where: { tenantId: msg.tenantId, category: "SMS", refId: msg.id }, data: { costCents: toCents(cost), costSource: "telnyx" } });
      await prisma.vendorUsage.deleteMany({ where: { vendor: "telnyx", vendorRecordId: `est:msg:${msg.id}` } });
      matched++;
    }
  }
  return { records: mdrs.length, matched, costCents: toCents(mc) };
}

/** Telnyx record types billed per record that we do not match to a call: kept as shared (unattributed) cost. */
export const TELNYX_OTHER_KINDS = ["amd", "conference", "conference-participant", "call-control", "recording", "media_storage", "media-streaming", "stt", "tts", "webrtc"];

export async function pullTelnyxOther(dateRange = "last_3_days"): Promise<{ records: number; costCents: number }> {
  let records = 0;
  let mc = 0;
  for (const kind of TELNYX_OTHER_KINDS) {
    let rows: (Cdr & { invoked_at?: string; joined_at?: string; created_at?: string })[] = [];
    try {
      rows = await detailRecords(kind, dateRange);
    } catch (e) {
      log.debug({ kind, err: e }, "telnyx detail records: type not available");
      continue;
    }
    for (const r of rows) {
      const cost = dollarsToMillicents(r.cost);
      if (await keepUsage({ vendor: "telnyx", kind, recordId: r.id ?? r.uuid ?? null, millicents: cost, day: dayOf(r.started_at ?? r.invoked_at ?? r.joined_at ?? r.created_at), source: "api" })) {
        records++;
        mc += cost;
      }
    }
  }
  return { records, costCents: toCents(mc) };
}

export async function pullTelnyxBalance(): Promise<number> {
  const r = await telnyxGet<{ data: { balance: string; currency: string; credit_limit?: string } }>("/balance", {});
  const cents = Math.round(Number(r.data.balance) * 100);
  await synced("telnyx", { balanceCents: cents, balanceSource: "api", balanceAt: new Date() });
  return cents;
}

/** Number rental: one row per Telnyx number per month, to the client holding it (pool numbers included), at the number rate. */
export async function recordNumberCosts(period = thisPeriod()): Promise<number> {
  const r = await rates();
  const numbers = await prisma.callerIdNumber.findMany({ where: { provider: "telnyx", status: { not: "RETIRED" }, provisionStatus: { in: ["ready", "voice", "ordered"] } }, select: { id: true, tenantId: true } });
  let added = 0;
  for (const n of numbers) {
    if (await keepUsage({ vendor: "telnyx", kind: "number", recordId: `did:${n.id}:${period}`, millicents: r.didMonthlyCents * 1000, day: `${period}-01`, tenantId: n.tenantId, refId: n.id, source: "usage" })) added++;
  }
  return added;
}

// ---- Fixed monthly costs (no usable API): written once per month they cover

export async function materialiseFixedCosts(upTo = thisPeriod()): Promise<number> {
  const costs = await prisma.vendorFixedCost.findMany();
  let rows = 0;
  for (const c of costs) {
    const months = c.amountCents > 0 ? periodsCovered(c, upTo) : [];
    for (const p of months) {
      await keepUsage({ vendor: c.vendor, kind: c.kind, recordId: `fixed:${c.id}:${p}`, millicents: c.amountCents * 1000, day: `${p}-01`, tenantId: c.tenantId, refId: c.id, source: "fixed", replace: true });
      rows++;
    }
    // A month taken out of the range (or the amount set to 0) loses its row.
    await prisma.vendorUsage.deleteMany({ where: { source: "fixed", refId: c.id, vendorRecordId: { notIn: months.map((p) => `fixed:${c.id}:${p}`) } } });
  }
  // A fixed cost deleted from /platform takes its rows with it.
  await prisma.vendorUsage.deleteMany({ where: { source: "fixed", refId: { notIn: costs.map((c) => c.id) } } });
  return rows;
}

// ---- jambonz.cloud: the plan is a monthly subscription. The API is tried for
// the upcoming invoice (GET /v1/Invoices, jambonz-api-server's Stripe route);
// when it answers with an amount and no jambonz fixed cost is entered, the
// invoice is this month's cost (source api). Otherwise the fixed cost counts and
// the invoice is shown beside it for comparison.

async function jambonzGet<T>(path: string): Promise<T> {
  if (!config.JAMBONZ_API_KEY) throw new Error("JAMBONZ_API_KEY is not set");
  const res = await fetch(config.JAMBONZ_API_URL.replace(/\/+$/, "") + "/v1" + path, { headers: { authorization: `Bearer ${config.JAMBONZ_API_KEY}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`jambonz GET ${path}: ${res.status} ${text.slice(0, 160)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function pullJambonz(): Promise<{ plan: string | null; invoiceCents: number | null }> {
  const period = thisPeriod();
  let plan: string | null = null;
  if (config.JAMBONZ_ACCOUNT_SID) {
    const a = await jambonzGet<Record<string, unknown> | Record<string, unknown>[]>(`/Accounts/${config.JAMBONZ_ACCOUNT_SID}`);
    const acct = (Array.isArray(a) ? a[0] : a) ?? {};
    plan = [acct.plan_type, acct.trial_end_date ? `trial ends ${String(acct.trial_end_date).slice(0, 10)}` : null].filter(Boolean).join(", ") || null;
  }
  let invoiceCents: number | null = null;
  try {
    const inv = await jambonzGet<Record<string, unknown> | null>("/Invoices");
    const v = inv ? (inv.total ?? inv.amount_due ?? inv.subtotal) : null;
    invoiceCents = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  } catch (e) {
    log.debug({ err: e }, "jambonz invoice not available to this key");
  }
  await synced("jambonz", { usageSyncedAt: new Date(), note: plan ? `Plan: ${plan}` : null, ...(invoiceCents !== null ? { reportedPeriod: period, reportedCents: invoiceCents, reportedAt: new Date() } : {}) });
  const entered = await prisma.vendorFixedCost.findFirst({ where: { vendor: "jambonz", amountCents: { gt: 0 }, startPeriod: { lte: period }, OR: [{ endPeriod: null }, { endPeriod: { gte: period } }] } });
  const key = `invoice:${period}`;
  if (invoiceCents !== null && invoiceCents > 0 && !entered) await keepUsage({ vendor: "jambonz", kind: "subscription", recordId: key, millicents: invoiceCents * 1000, day: `${period}-01`, source: "api", replace: true });
  else await prisma.vendorUsage.deleteMany({ where: { vendor: "jambonz", vendorRecordId: key } });
  return { plan, invoiceCents };
}

// ---- Anthropic. Per request, from res.usage at list price (recordAiUsage).
// With ANTHROPIC_ADMIN_KEY the Admin API cost report (legacy Usage and Cost API,
// GET /v1/organizations/cost_report, daily buckets, USD as decimal strings in
// cents) gives the month as Anthropic bills it, shown beside what we recorded.
// No API exposes the prepaid credit balance: it is entered on /platform.

export async function pullAnthropicReport(): Promise<number | null> {
  if (!config.ANTHROPIC_ADMIN_KEY) return null;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let cents = 0;
  let page: string | null = null;
  for (let i = 0; i < 10; i++) {
    const u = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    u.searchParams.set("starting_at", start.toISOString().replace(/\.\d{3}Z$/, "Z"));
    u.searchParams.set("ending_at", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().replace(/\.\d{3}Z$/, "Z"));
    u.searchParams.set("bucket_width", "1d");
    u.searchParams.set("limit", "31");
    if (page) u.searchParams.set("page", page);
    const res = await fetch(u, { headers: { "x-api-key": config.ANTHROPIC_ADMIN_KEY, "anthropic-version": "2026-10-21", "user-agent": "strowger-engine/1.0" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Anthropic cost report: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const body = (await res.json()) as { data?: Array<{ results?: Array<{ amount?: string | number | { amount?: string | number } }> }>; has_more?: boolean; next_page?: string | null };
    for (const bucket of body.data ?? []) for (const r of bucket.results ?? []) cents += Number(typeof r.amount === "object" && r.amount !== null ? r.amount.amount : r.amount) || 0;
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  const rounded = Math.round(cents);
  await synced("anthropic", { reportedPeriod: thisPeriod(), reportedCents: rounded, reportedAt: new Date() });
  return rounded;
}

// ---- AI (Anthropic) usage at list price. Claude Opus 5.5: $4 / MTok in, $20 / MTok out, cache read $0.20, cache write $5.
const AI_PRICE_MICROCENTS_PER_TOKEN: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 400, output: 2000, cacheRead: 20, cacheWrite: 500 },
  // List prices checked 6 Nov (claude-api skill): Sonnet 5.5 $2 / $10 per MTok (cache read $0.20), Haiku 5.5 $0.10 / $0.50.
  // Cache writes taken as 1.25 × input. Until 6 Nov these two rows read $3 / $15 and $1 / $5.
  "claude-sonnet-5-5": { input: 200, output: 1000, cacheRead: 20, cacheWrite: 250 },
  "claude-haiku-5-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 13 },
};

export async function recordAiUsage(tenantId: string | null, kind: string, model: string, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }, refId?: string): Promise<void> {
  const p = AI_PRICE_MICROCENTS_PER_TOKEN[model] ?? AI_PRICE_MICROCENTS_PER_TOKEN["claude-opus-5-5"]!;
  const micro = (usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite;
  // The table is in millionths of a cent per token ($4 / MTok = 400), so millicents = micro / 1,000. Kept unrounded per request (6 Nov: a
  // Haiku text classification is a hundredth of a cent and used to round to 0).
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  await keepUsage({ vendor: "anthropic", kind, millicents: micro / 1000, tenantId, refId, quantity: tokens, source: "usage" }).catch((e) => log.warn({ err: e }, "ai usage record failed"));
}

// ---- Text to speech (Cartesia through jambonz). jambonz does not report
// characters back, so the engine counts what each hook reply asks it to say
// and prices it at PlatformRates.ttsCostMillicentsPerKChar. jambonz caches
// synthesised audio for repeated identical text, so this errs high.

export async function recordTts(callSid: string | undefined, chars: number): Promise<void> {
  if (chars <= 0) return;
  const callId = callSid ? await redis.get(`callsid:${callSid}`) : null;
  const call = callId ? await prisma.call.findUnique({ where: { id: callId }, select: { id: true, tenantId: true } }) : null;
  const r = await rates();
  await keepUsage({ vendor: (config.TTS_VENDOR ?? "cartesia").toLowerCase(), kind: "tts", millicents: (chars * r.ttsCostMillicentsPerKChar) / 1000, tenantId: call?.tenantId, refId: call?.id, quantity: chars, source: "usage" });
}

// ---- The jobs

/** Hourly: usage from every vendor with an API, number rental, fixed costs into this month. A vendor that fails does not stop the others. */
export async function syncVendorUsage(dateRange = "last_2_days") {
  const out: Record<string, unknown> = {};
  if (config.TELNYX_API_KEY) {
    try {
      out.calls = await pullTelnyxCalls(dateRange);
      out.messages = await pullTelnyxMessages(dateRange);
      out.other = await pullTelnyxOther(dateRange);
      await synced("telnyx", { usageSyncedAt: new Date() });
    } catch (e) {
      await noteError("telnyx", e);
    }
  }
  out.numbers = await recordNumberCosts().catch((e) => noteError("telnyx", e));
  out.fixed = await materialiseFixedCosts();
  log.info(out, "vendor usage synced");
  return out;
}

/** Daily: balances and the vendors' own month totals. */
export async function syncVendorBalances() {
  const out: Record<string, unknown> = {};
  if (config.TELNYX_API_KEY) out.telnyxBalanceCents = await pullTelnyxBalance().catch((e) => noteError("telnyx", e));
  if (config.JAMBONZ_API_KEY) out.jambonz = await pullJambonz().catch((e) => noteError("jambonz", e));
  if (config.ANTHROPIC_ADMIN_KEY) out.anthropicReportCents = await pullAnthropicReport().catch((e) => noteError("anthropic", e));
  log.info(out, "vendor balances synced");
  return out;
}

/** "Sync now" on /platform. */
export async function syncAllVendors(dateRange = "last_7_days") {
  return { usage: await syncVendorUsage(dateRange), balances: await syncVendorBalances() };
}

/** @deprecated name kept for the existing route; same as syncAllVendors. */
export const syncTelnyxCosts = syncAllVendors;

// ---- Vendor accounts (balances, warning lines) for the platform page

/** The vendors the platform pays; balances shown even before the first sync. */
export const KNOWN_VENDORS: Array<{ vendor: string; label: string; api: string }> = [
  { vendor: "telnyx", label: "Telnyx", api: "Detail records hourly, balance daily" },
  { vendor: "jambonz", label: "jambonz.cloud", api: "Plan and upcoming invoice daily (when the key may read them); else the fixed cost" },
  { vendor: "anthropic", label: "Anthropic", api: "Per request from token usage; month total from the Admin API cost report when ANTHROPIC_ADMIN_KEY is set" },
  { vendor: "cartesia", label: "Cartesia (text to speech)", api: "Characters spoken × rate (no usage API)" },
  { vendor: "deepgram", label: "Speech to text", api: "Transcribed leg-minutes × rate" },
  { vendor: "subscriberverify", label: "SubscriberVerify (litigator scrub)", api: "Records scrubbed × invoice rate" },
  { vendor: "railway", label: "Railway", api: "Fixed monthly" },
  { vendor: "clerk", label: "Clerk", api: "Fixed monthly" },
];

export async function vendorAccounts() {
  const rows = await prisma.vendorAccount.findMany();
  const used = await prisma.vendorUsage.groupBy({ by: ["vendor"], _count: { _all: true } });
  const names = new Set([...KNOWN_VENDORS.map((v) => v.vendor), ...rows.map((r) => r.vendor), ...used.map((u) => u.vendor)]);
  return [...names].map((vendor) => {
    const a = rows.find((r) => r.vendor === vendor);
    const k = KNOWN_VENDORS.find((v) => v.vendor === vendor);
    return {
      vendor,
      label: k?.label ?? vendor,
      api: k?.api ?? "Recorded per event",
      balanceCents: a?.balanceCents ?? null,
      balanceSource: a?.balanceSource ?? null,
      balanceAt: a?.balanceAt?.toISOString() ?? null,
      lowBalanceCents: a?.lowBalanceCents ?? null,
      usageSyncedAt: a?.usageSyncedAt?.toISOString() ?? null,
      reportedPeriod: a?.reportedPeriod ?? null,
      reportedCents: a?.reportedCents ?? null,
      reportedAt: a?.reportedAt?.toISOString() ?? null,
      lastError: a?.lastError ?? null,
      lastErrorAt: a?.lastErrorAt?.toISOString() ?? null,
      note: a?.note ?? null,
    };
  });
}

/** Owner edits on /platform: the warning line, and a balance for vendors whose API has none (jambonz, Anthropic credits, Cartesia). */
export async function saveVendorAccount(i: { vendor: string; lowBalanceCents: number | null; balanceCents?: number | null }): Promise<void> {
  await vendorAccount(i.vendor);
  await prisma.vendorAccount.update({
    where: { vendor: i.vendor },
    data: { lowBalanceCents: i.lowBalanceCents, ...(i.balanceCents !== undefined ? { balanceCents: i.balanceCents, balanceSource: i.balanceCents === null ? null : "manual", balanceAt: i.balanceCents === null ? null : new Date() } : {}) },
  });
}

/** Platform view: vendor spend for a month by vendor, kind and source, attributed vs not. */
export async function vendorSpend(period = thisPeriod()) {
  const rows = await prisma.vendorUsage.groupBy({ by: ["vendor", "kind", "source"], where: { day: { startsWith: period } }, _sum: { costMillicents: true, quantity: true }, _count: { _all: true } });
  const unattributed = await prisma.vendorUsage.aggregate({ where: { day: { startsWith: period }, tenantId: null }, _sum: { costMillicents: true } });
  const byTenant = await prisma.vendorUsage.groupBy({ by: ["tenantId"], where: { day: { startsWith: period }, tenantId: { not: null } }, _sum: { costMillicents: true } });
  const telnyx = await prisma.vendorAccount.findUnique({ where: { vendor: "telnyx" } });
  return {
    period,
    rows: rows.map((x) => ({ vendor: x.vendor, kind: x.kind, source: x.source, costCents: toCents(x._sum.costMillicents ?? 0), quantity: Number(x._sum.quantity ?? 0), records: x._count._all })),
    totalCents: toCents(rows.reduce((n, x) => n + (x._sum.costMillicents ?? 0), 0)),
    unattributedCents: toCents(unattributed._sum.costMillicents ?? 0),
    byTenant: byTenant.map((x) => ({ tenantId: x.tenantId!, costCents: toCents(x._sum.costMillicents ?? 0) })),
    telnyxBalanceCents: telnyx?.balanceCents ?? null,
    telnyxBalanceAt: telnyx?.balanceAt?.toISOString() ?? null,
    telnyxSyncedAt: telnyx?.usageSyncedAt?.toISOString() ?? null,
  };
}
