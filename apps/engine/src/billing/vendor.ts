// What vendors actually charge us, pulled from their APIs (owner, 5 Nov:
// "get the pricing in via the API on everything"). Telnyx detail records
// (calls, texts, AMD, conferences…) are matched to our Call and Message rows
// so every BillingEntry carries the real cost; the account balance is kept
// too. AI requests are costed from their token usage at list price.
import { prisma } from "@strowger/db";
import { config } from "../config";
import { log } from "../log";
import { rates } from "./index";

const TELNYX = config.TELNYX_API_URL.replace(/\/+$/, "");
const e164 = (phone: string) => (phone.startsWith("+") ? phone : `+1${phone}`);
const dollarsToCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const dayOf = (iso: string | undefined) => (iso ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10));

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

async function keepUsage(vendor: string, kind: string, vendorRecordId: string | null, costCents: number, day: string, tenantId: string | null, refId: string | null, quantity = 1): Promise<boolean> {
  if (!vendorRecordId) {
    await prisma.vendorUsage.create({ data: { vendor, kind, costCents, day, tenantId, refId, quantity } });
    return true;
  }
  const existing = await prisma.vendorUsage.findUnique({ where: { vendor_vendorRecordId: { vendor, vendorRecordId } } });
  if (existing) return false;
  await prisma.vendorUsage.create({ data: { vendor, kind, vendorRecordId, costCents, day, tenantId, refId, quantity } });
  return true;
}

/** Attach the carrier's real cost to the Call and its MINUTES entry. */
async function applyCallCost(callId: string, tenantId: string, costCents: number, recordId: string): Promise<void> {
  await prisma.call.update({ where: { id: callId }, data: { vendorCostCents: costCents, vendorRecordId: recordId } });
  await prisma.billingEntry.updateMany({ where: { tenantId, category: "MINUTES", refId: callId }, data: { costCents, costSource: "telnyx" } });
}

/** Calls: match by direction, the far-end number and a start time within three minutes. A transfer's destination leg is outbound at the carrier. */
export async function pullTelnyxCalls(dateRange = "last_3_days"): Promise<{ records: number; matched: number; costCents: number }> {
  const cdrs = await detailRecords<Cdr>("sip-trunking", dateRange);
  let matched = 0;
  let costCents = 0;
  for (const r of cdrs) {
    const id = r.id ?? r.uuid ?? r.call_leg_id ?? null;
    const cost = dollarsToCents(r.cost);
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
    const fresh = await keepUsage("telnyx", "sip-trunking", id, cost, dayOf(r.started_at), call?.tenantId ?? null, call?.id ?? null, (r.billed_sec ?? r.call_sec ?? 0) / 60);
    if (!fresh) continue;
    costCents += cost;
    if (call) {
      await applyCallCost(call.id, call.tenantId, cost, id ?? "");
      matched++;
    }
  }
  return { records: cdrs.length, matched, costCents };
}

/** Texts: the message id Telnyx gave us at send time is the detail record's uuid. */
export async function pullTelnyxMessages(dateRange = "last_3_days"): Promise<{ records: number; matched: number; costCents: number }> {
  const mdrs = await detailRecords<Mdr>("messaging", dateRange);
  let matched = 0;
  let costCents = 0;
  for (const r of mdrs) {
    const id = r.uuid ?? r.id ?? null;
    const cost = dollarsToCents(r.cost) + dollarsToCents(r.carrier_fee);
    const msg = id ? await prisma.message.findFirst({ where: { providerMessageId: id }, select: { id: true, tenantId: true } }) : null;
    const fresh = await keepUsage("telnyx", "messaging", id, cost, dayOf(r.created_at), msg?.tenantId ?? null, msg?.id ?? null, r.parts ?? 1);
    if (!fresh) continue;
    costCents += cost;
    if (msg) {
      await prisma.message.update({ where: { id: msg.id }, data: { vendorCostCents: cost } });
      await prisma.billingEntry.updateMany({ where: { tenantId: msg.tenantId, category: "SMS", refId: msg.id }, data: { costCents: cost, costSource: "telnyx" } });
      matched++;
    }
  }
  return { records: mdrs.length, matched, costCents };
}

/** Everything else Telnyx bills per record (AMD, conferences, recordings…): kept as unattributed platform cost. */
export async function pullTelnyxOther(dateRange = "last_3_days"): Promise<{ records: number; costCents: number }> {
  let records = 0;
  let costCents = 0;
  for (const kind of ["amd", "conference-participant", "recording", "media_storage", "stt", "tts", "webrtc"]) {
    let rows: (Cdr & { invoked_at?: string; joined_at?: string; created_at?: string })[] = [];
    try {
      rows = await detailRecords(kind, dateRange);
    } catch (e) {
      log.debug({ kind, err: e }, "telnyx detail records: type not available");
      continue;
    }
    for (const r of rows) {
      const id = r.id ?? r.uuid ?? null;
      const cost = dollarsToCents(r.cost);
      const fresh = await keepUsage("telnyx", kind, id, cost, dayOf(r.started_at ?? r.invoked_at ?? r.joined_at ?? r.created_at), null, null);
      if (fresh) {
        records++;
        costCents += cost;
      }
    }
  }
  return { records, costCents };
}

export async function pullTelnyxBalance(): Promise<number | null> {
  const r = await telnyxGet<{ data: { balance: string; currency: string } }>("/balance", {});
  const cents = dollarsToCents(r.data.balance);
  await rates();
  await prisma.platformRates.update({ where: { id: "default" }, data: { telnyxBalanceCents: cents, telnyxBalanceAt: new Date() } });
  return cents;
}

/** The hourly job: calls, texts, the rest, the balance. */
export async function syncTelnyxCosts(dateRange = "last_3_days"): Promise<{ calls: Awaited<ReturnType<typeof pullTelnyxCalls>>; messages: Awaited<ReturnType<typeof pullTelnyxMessages>>; other: Awaited<ReturnType<typeof pullTelnyxOther>>; balanceCents: number | null }> {
  if (!config.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not set on the engine");
  const calls = await pullTelnyxCalls(dateRange);
  const messages = await pullTelnyxMessages(dateRange);
  const other = await pullTelnyxOther(dateRange);
  let balanceCents: number | null = null;
  try {
    balanceCents = await pullTelnyxBalance();
  } catch (e) {
    log.warn({ err: e }, "telnyx balance failed");
  }
  await prisma.platformRates.update({ where: { id: "default" }, data: { telnyxSyncedAt: new Date() } });
  log.info({ calls, messages, other, balanceCents }, "telnyx costs synced");
  return { calls, messages, other, balanceCents };
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
  // The table is in millionths of a cent per token ($4 / MTok = 400). Until 6 Nov this divided by 10,000: every AI cost read 100× too high.
  const costCents = Math.round(micro / 1_000_000);
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  await prisma.vendorUsage.create({ data: { vendor: "anthropic", kind, costCents, day: new Date().toISOString().slice(0, 10), tenantId, refId, quantity: tokens } }).catch((e) => log.warn({ err: e }, "ai usage record failed"));
}

/** Platform view: vendor spend this month by vendor and kind, attributed vs not. */
export async function vendorSpend(period = new Date().toISOString().slice(0, 7)) {
  const rows = await prisma.vendorUsage.groupBy({ by: ["vendor", "kind"], where: { day: { startsWith: period } }, _sum: { costCents: true, quantity: true }, _count: { _all: true } });
  const unattributed = await prisma.vendorUsage.aggregate({ where: { day: { startsWith: period }, tenantId: null }, _sum: { costCents: true } });
  const byTenant = await prisma.vendorUsage.groupBy({ by: ["tenantId"], where: { day: { startsWith: period }, tenantId: { not: null } }, _sum: { costCents: true } });
  const r = await rates();
  return {
    period,
    rows: rows.map((x) => ({ vendor: x.vendor, kind: x.kind, costCents: x._sum.costCents ?? 0, quantity: Number(x._sum.quantity ?? 0), records: x._count._all })),
    totalCents: rows.reduce((n, x) => n + (x._sum.costCents ?? 0), 0),
    unattributedCents: unattributed._sum.costCents ?? 0,
    byTenant: byTenant.map((x) => ({ tenantId: x.tenantId!, costCents: x._sum.costCents ?? 0 })),
    telnyxBalanceCents: r.telnyxBalanceCents,
    telnyxBalanceAt: r.telnyxBalanceAt?.toISOString() ?? null,
    telnyxSyncedAt: r.telnyxSyncedAt?.toISOString() ?? null,
  };
}
