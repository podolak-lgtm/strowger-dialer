// Rules and parsing for collecting vendor costs and balances (owner, 6 Nov:
// "you log in, find it and download whatever you need to keep it updated").
// The engine's connectors (apps/engine/src/billing/vendors) call these; the
// rules live here so they are tested and in one place.
//
// THE NO-DOUBLE-COUNT RULE, per vendor and month:
//
//   1. A vendor whose cost we already count per event (Telnyx calls and texts,
//      Anthropic tokens, Deepgram minutes, SubscriberVerify records) is
//      "reconcile": its invoice is stored and its total shown beside ours, but
//      never written as cost (it would count every call twice).
//   2. Any other vendor is "replaces": its month-level rows compete, and only
//      the best kind counts:  invoice  >  the API's running month total  >  fixed.
//      An invoice for October removes October's running total and skips the
//      October fixed-cost row; a running total skips the fixed row until an
//      invoice arrives. Per-event rows are never touched by this rule.

export type InvoiceMode = "replaces" | "reconcile";

/** Vendors whose cost is already counted per event: their invoices are for reconciliation only. */
export const RECONCILE_ONLY = new Set(["telnyx", "anthropic", "deepgram", "subscriberverify"]);

export function invoiceMode(vendor: string): InvoiceMode {
  return RECONCILE_ONLY.has(vendor.toLowerCase()) ? "reconcile" : "replaces";
}

/** The month-level kinds of row that compete for one vendor and month. */
export type MonthClass = "invoice" | "period" | "fixed";
const RANK: Record<MonthClass, number> = { invoice: 3, period: 2, fixed: 1 };

/** Which month-level kind counts, given the kinds present for a vendor and month (null = none present). */
export function winningClass(present: Iterable<MonthClass>): MonthClass | null {
  let best: MonthClass | null = null;
  for (const c of present) if (!best || RANK[c] > RANK[best]) best = c;
  return best;
}

/** Whether a row of this kind should be kept (written, or left in place) for the vendor and month. */
export function monthRowCounts(vendor: string, cls: MonthClass, present: Iterable<MonthClass>): boolean {
  if (cls === "invoice" && invoiceMode(vendor) === "reconcile") return false;
  const all = new Set(present);
  all.add(cls);
  if (invoiceMode(vendor) === "reconcile") all.delete("invoice");
  return winningClass(all) === cls;
}

/** The VendorUsage key of a running month total from a vendor's API: period:<YYYY-MM>:<part>. */
export const periodKey = (period: string, part: string) => `period:${period}:${part.replace(/[^\w.:@/-]+/g, "_").slice(0, 120)}`;

/** The VendorUsage key of one invoice line: invoice:<vendor>:<invoice number, or the month>[:<line>]. */
export function invoiceKey(vendor: string, invoiceNumber: string | null | undefined, period: string, line?: number): string {
  const id = (invoiceNumber ?? "").trim().replace(/[^\w.-]+/g, "_").slice(0, 60) || period;
  return `invoice:${vendor.toLowerCase()}:${id}${line !== undefined ? `:${line}` : ""}`;
}

/** The month an invoice belongs to: the month holding the middle of its service period (a billing cycle that crosses a month end goes to the month with most of it). */
export function invoicePeriod(start?: string | null, end?: string | null, fallback?: string | null): string | null {
  const a = start ? Date.parse(start) : NaN;
  const b = end ? Date.parse(end) : NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return new Date(a + (b - a) / 2).toISOString().slice(0, 7);
  if (Number.isFinite(a)) return new Date(a).toISOString().slice(0, 7);
  if (fallback && /^\d{4}-(0[1-9]|1[0-2])$/.test(fallback)) return fallback;
  if (Number.isFinite(b)) return new Date(b - 86_400_000).toISOString().slice(0, 7);
  return null;
}

// ---- Money

/** "$1,234.56", "1234.56", 1234.56 → millicents. Null when it is not a number. */
export function dollarsToMillicents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(n) ? Math.round(n * 100_000) : null;
}

// ---- Vercel: FOCUS charges (GET /v1/billing/charges, JSONL)

export interface FocusCharge {
  BilledCost?: string | number;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ConsumedQuantity?: string | number | null;
  ServiceName?: string;
  SkuId?: string;
  Tags?: Record<string, unknown> | string | null;
}

export interface PeriodRow {
  /** Stable part of the key inside the month (service, project). */
  part: string;
  kind: string;
  millicents: number;
  quantity: number;
  label: string;
}

/** Sum a month's FOCUS charges by service and project, one row each. Lines that do not parse are skipped. */
export function aggregateFocus(jsonl: string, period: string): PeriodRow[] {
  const out = new Map<string, PeriodRow>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let c: FocusCharge;
    try {
      c = JSON.parse(line) as FocusCharge;
    } catch {
      continue;
    }
    if (c.ChargePeriodStart && !c.ChargePeriodStart.startsWith(period)) continue;
    const mc = dollarsToMillicents(c.BilledCost);
    if (mc === null) continue;
    const tags = typeof c.Tags === "string" ? safeJson(c.Tags) : c.Tags;
    const project = String((tags as Record<string, unknown> | null)?.ProjectName ?? (tags as Record<string, unknown> | null)?.ProjectId ?? "team");
    const service = c.ServiceName ?? c.SkuId ?? "charge";
    const part = `${service}@${project}`;
    const row = out.get(part) ?? { part, kind: (c.ChargeCategory ?? "usage").toLowerCase() === "purchase" ? "subscription" : "hosting", millicents: 0, quantity: 0, label: `${service} (${project})` };
    row.millicents += mc;
    row.quantity += Number(c.ConsumedQuantity ?? 0) || 0;
    out.set(part, row);
  }
  return [...out.values()].filter((r) => r.millicents !== 0);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- Railway: resource usage → dollars at the published rates (docs.railway.com/pricing/plans, checked 6 Nov 2026).
// The usage query returns vCPU-minutes, GB-minutes of memory and of disk, and GB of egress.

export const RAILWAY_RATES = {
  CPU_USAGE: 0.000463, // $ per vCPU-minute ($20 / vCPU / month)
  MEMORY_USAGE_GB: 0.000231, // $ per GB-minute ($10 / GB / month)
  NETWORK_TX_GB: 0.05, // $ per GB egress
  DISK_USAGE_GB: 0.000003472222222, // $ per GB-minute of volume ($0.15 / GB / month)
} as const;
export type RailwayMeasurement = keyof typeof RAILWAY_RATES;

export function railwayCostMillicents(values: Partial<Record<RailwayMeasurement, number>>): number {
  let dollars = 0;
  for (const [k, rate] of Object.entries(RAILWAY_RATES)) dollars += (values[k as RailwayMeasurement] ?? 0) * rate;
  return Math.round(dollars * 100_000);
}

// ---- Email codes (a vendor's one-time sign-in code, read from Crossbar's inbox)

/** A sign-in code in an email: digits (4 to 8) or a short letters-and-digits token near the word "code". Null when none. */
export function extractEmailCode(text: string): string | null {
  const body = text.replace(/https?:\/\/\S+/g, " ");
  // Every token after one of the words; the first with a digit wins (so "passcode" itself is never the code).
  for (const m of body.matchAll(/code|one[- ]time|verification|verify/gi)) {
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const token = /\b(\d{4,8}|(?=[A-Z]*\d)[A-Z0-9]{5,8})\b/.exec(after)?.[1];
    if (token) return token;
  }
  const digits = /\b(\d{6})\b/.exec(body)?.[1];
  return digits ?? null;
}

// ---- Secrets on screen

/** What the browser may see of a saved secret: its last four characters. */
export function secretHint(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return v.length <= 4 ? "saved" : `saved, ending …${v.slice(-4)}`;
}

// ---- Files in the media bucket (private: never served by the public /api/media route)

export const VENDOR_FILE_PREFIXES = ["vendor-invoices/", "vendor-screens/"] as const;
export const isVendorFileKey = (key: string) => VENDOR_FILE_PREFIXES.some((p) => key.startsWith(p));

export function invoiceFileKey(vendor: string, period: string, ext: "pdf" | "csv", invoiceNumber?: string | null): string {
  const n = (invoiceNumber ?? "").replace(/[^\w.-]+/g, "_").slice(0, 40);
  return `vendor-invoices/${vendor.toLowerCase().replace(/[^\w-]+/g, "_")}/${period}${n ? `-${n}` : ""}.${ext}`;
}

/** PDF or CSV, from the bytes first, then the name and type. Null = not something we read. */
export function sniffInvoiceFile(name: string, contentType: string | null | undefined, head: Uint8Array): "pdf" | "csv" | null {
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf"; // %PDF
  if (/\.pdf$/i.test(name) || contentType === "application/pdf") return null; // claims PDF, is not
  if (/\.(csv|tsv|txt)$/i.test(name) || /^text\/(csv|plain|tab-separated-values)/.test(contentType ?? "")) {
    // Text: no NUL bytes in the first chunk.
    return head.subarray(0, 4096).includes(0) ? null : "csv";
  }
  return null;
}

// ---- The nightly run

/** The nightly collection runs on the first tick at or after this UTC hour (2-3 a.m. US Eastern), once a day. */
export const NIGHTLY_HOUR_UTC = 7;
export function nightlyDue(now: Date, lastRunDay: string | null, hourUtc = NIGHTLY_HOUR_UTC): boolean {
  return now.getUTCHours() >= hourUtc && lastRunDay !== now.toISOString().slice(0, 10);
}

export interface RunOutcome {
  vendor: string;
  label: string;
  status: "ok" | "failed" | "needs_person" | "skipped";
  error?: string | null;
}
export interface BalanceLine {
  label: string;
  balanceCents: number | null;
  lowBalanceCents: number | null;
}

/** The admins' email after a nightly run: only when something failed, needs a person, or a balance is at or under its line. */
export function nightlySummary(runs: RunOutcome[], balances: BalanceLine[]): { subject: string; lines: string[] } | null {
  const failed = runs.filter((r) => r.status === "failed" || r.status === "needs_person");
  const low = balances.filter((b) => b.balanceCents !== null && b.lowBalanceCents !== null && b.balanceCents <= b.lowBalanceCents);
  if (!failed.length && !low.length) return null;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const lines = [
    ...failed.map((r) => `${r.label}: ${r.status === "needs_person" ? "needs a person" : "failed"}${r.error ? ` (${r.error})` : ""}.`),
    ...low.map((b) => `${b.label} balance is ${usd(b.balanceCents!)}, at or under its ${usd(b.lowBalanceCents!)} line.`),
  ];
  const parts = [failed.length ? `${failed.length} collection${failed.length === 1 ? "" : "s"} need attention` : null, low.length ? `${low.length} low balance${low.length === 1 ? "" : "s"}` : null].filter(Boolean);
  return { subject: `Vendor costs: ${parts.join(", ")}`, lines };
}
