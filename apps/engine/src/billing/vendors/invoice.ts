// Vendor invoices: read by Claude (structured output) and written through the
// cost model. A PDF goes in as a document block, a CSV as text. The result is
// one VendorInvoice row and, unless the vendor is reconcile-only, one
// VendorUsage row per line (source "invoice", keyed invoice:<vendor>:<ref>:<n>),
// which replaces that vendor's fixed cost and API running total for the month
// (@strowger/shared/vendor-collect, the no-double-count rule).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { prisma } from "@strowger/db";
import { invoiceFileKey, invoiceKey, invoiceMode, invoicePeriod } from "@strowger/shared/vendor-collect";
import { config } from "../../config";
import { log } from "../../log";
import { keepUsage, materialiseFixedCosts, periodRowsWhere, recordAiUsage, synced } from "../vendor";
import { putVendorFile } from "./storage";
import type { FoundInvoice, InvoiceLine } from "./types";

const InvoiceRead = z.object({
  /** The company that issued the document. */
  vendor: z.string(),
  invoice_number: z.string().nullable(),
  /** Service period, YYYY-MM-DD, when printed. */
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  /** ISO 4217, e.g. USD. */
  currency: z.string(),
  line_items: z.array(z.object({ description: z.string(), quantity: z.number().nullable(), amount: z.number() })),
  /** Amount charged for the period, after credits and tax. */
  total: z.number(),
  /** False for something that is not an invoice, receipt or usage statement. */
  is_invoice: z.boolean(),
});
type InvoiceRead = z.infer<typeof InvoiceRead>;

const SYSTEM = `You read invoices, receipts and usage statements that software vendors send a small business, and return their contents exactly as printed.

Rules:
- line_items: every charge line with its description, quantity (null if none is printed) and amount in the invoice currency as a plain number (credits and discounts negative). Include tax as its own line when it is shown separately.
- total: the amount charged for the period after credits and tax (the "Total" or "Amount due" for this invoice, not a running account balance).
- period_start and period_end: the service or billing period as YYYY-MM-DD, null if none is printed (do not use the issue date).
- invoice_number: as printed, null if there is none.
- For a usage CSV with no invoice number, return each row or service as a line item and the sum as the total.
- is_invoice: false when the document is not an invoice, receipt or usage statement; then return empty line items and a total of 0.
Never invent figures that are not in the document.`;

let client: Anthropic | null = null;
export const invoiceReadingConfigured = Boolean(config.ANTHROPIC_API_KEY);

/** Claude's reading of the file. Throws with a readable reason. */
export async function readInvoiceFile(file: { bytes: Buffer; type: "pdf" | "csv" }, vendorHint: string): Promise<InvoiceRead> {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the engine, so invoices cannot be read");
  if (file.type === "pdf" && file.bytes.length > 30 * 1024 * 1024) throw new Error("The PDF is over 30 MB, too large to read in one request");
  if (file.type === "csv" && file.bytes.length > 1_500_000) throw new Error("The CSV is over 1.5 MB; upload the month's invoice or a summary export instead");
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 180_000, maxRetries: 1 });
  const doc: Anthropic.Beta.BetaContentBlockParam =
    file.type === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.bytes.toString("base64") } }
      : { type: "text", text: `CSV file:\n"""\n${file.bytes.toString("utf8")}\n"""` };
  const res = await client.beta.messages.parse({
    model: config.VENDOR_INVOICE_MODEL,
    max_tokens: 16000,
    // Refusal fallback: on a policy decline the API re-runs the request on a fallback model it picks.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [doc, { type: "text", text: `We expect this to be from ${vendorHint}. Read it.` }] }],
    output_config: { format: betaZodOutputFormat(InvoiceRead) },
  });
  void recordAiUsage(null, "ai.invoice", res.model || config.VENDOR_INVOICE_MODEL, res.usage);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this file");
  if (res.stop_reason === "max_tokens") throw new Error("The invoice has too many lines to read in one pass");
  const parsed = res.parsed_output;
  if (!parsed) throw new Error("Claude returned no reading of the file");
  if (!parsed.is_invoice) throw new Error(`This does not look like an invoice or usage statement (read as from "${parsed.vendor}")`);
  return parsed;
}

export interface ApplyResult {
  id: string;
  vendor: string;
  period: string;
  ref: string;
  totalCents: number | null;
  status: "read" | "reconcile";
  counted: boolean;
  warning?: string;
}

/**
 * Store, read (when needed) and write one invoice. Idempotent per (vendor, invoice number or month): reading the
 * same invoice again replaces its lines, never adds to them.
 */
export async function applyInvoice(vendor: string, found: FoundInvoice, origin: "upload" | "browser" | "api"): Promise<ApplyResult> {
  let lines: InvoiceLine[] | undefined = found.lines;
  let invoiceNumber = found.invoiceNumber ?? null;
  let periodStart = found.periodStart ?? null;
  let periodEnd = found.periodEnd ?? null;
  let currency = found.currency ?? null;
  let totalCents = found.totalCents ?? null;
  let warning: string | undefined;
  if (found.file && !lines) {
    const r = await readInvoiceFile(found.file, vendor);
    lines = r.line_items;
    invoiceNumber = invoiceNumber ?? r.invoice_number;
    periodStart = periodStart ?? r.period_start;
    periodEnd = periodEnd ?? r.period_end;
    currency = r.currency.toUpperCase();
    totalCents = Math.round(r.total * 100);
    if (!r.vendor.toLowerCase().includes(vendor.toLowerCase().slice(0, 4))) warning = `Read as an invoice from "${r.vendor}"; filed under ${vendor}`;
  }
  const period = invoicePeriod(periodStart, periodEnd, found.period ?? null);
  if (!period) throw new Error("The invoice shows no service period; upload it from the vendor's row with a month in its name, e.g. 2026-10.pdf");
  if (currency && currency !== "USD") warning = [warning, `Currency is ${currency}; amounts are taken as printed, not converted`].filter(Boolean).join(". ");
  const ref = (invoiceNumber ?? "").trim() || period;
  const key = invoiceKey(vendor, ref === period ? null : ref, period);

  let fileKey: string | null = null;
  if (found.file) fileKey = await putVendorFile(invoiceFileKey(vendor, period, found.file.type, ref === period ? null : ref), found.file.bytes, found.file.type === "pdf" ? "application/pdf" : "text/csv").catch((e) => (log.warn({ err: e, vendor }, "invoice file not stored"), null));

  const mode = invoiceMode(vendor);
  const row = await prisma.vendorInvoice.upsert({
    where: { vendor_ref: { vendor, ref } },
    create: { vendor, ref, period, invoiceNumber, origin, fileKey, fileType: found.file?.type ?? null, totalCents, currency, status: mode === "reconcile" ? "reconcile" : "read", error: warning ?? null, lines: (lines ?? []) as object[] },
    update: { period, invoiceNumber, origin, ...(fileKey ? { fileKey, fileType: found.file?.type ?? null } : {}), totalCents, currency, status: mode === "reconcile" ? "reconcile" : "read", error: warning ?? null, lines: (lines ?? []) as object[] },
  });

  if (mode === "reconcile") {
    // Counted per event already: keep the vendor's figure beside ours, write no cost.
    if (totalCents !== null) await synced(vendor, { reportedPeriod: period, reportedCents: totalCents, reportedAt: new Date() });
    return { id: row.id, vendor, period, ref, totalCents, status: "reconcile", counted: false, warning };
  }

  // Lines in millicents; a difference between the lines and the total (rounding, an unlisted credit) is its own line so the month equals the total.
  const parts = (lines ?? []).map((l) => ({ label: l.description.slice(0, 120), millicents: Math.round(l.amount * 100_000), quantity: l.quantity ?? 1 }));
  const sum = parts.reduce((n, p) => n + p.millicents, 0);
  if (totalCents !== null && Math.abs(totalCents * 1000 - sum) >= 1000) parts.push({ label: parts.length ? "Difference to the invoice total" : "Invoice total", millicents: totalCents * 1000 - sum, quantity: 1 });
  const keys: string[] = [];
  for (const [i, p] of parts.entries()) {
    const recordId = `${key}:${i}`;
    keys.push(recordId);
    await keepUsage({ vendor, kind: "invoice", recordId, millicents: p.millicents, day: `${period}-01`, refId: row.id, quantity: p.quantity, source: "invoice", replace: true });
  }
  // This invoice's lines from an earlier reading that are gone now; then the month's running total and fixed rows give way.
  await prisma.vendorUsage.deleteMany({ where: { vendor, source: "invoice", refId: row.id, vendorRecordId: { notIn: keys } } });
  await prisma.vendorUsage.deleteMany({ where: periodRowsWhere(vendor, period) });
  await materialiseFixedCosts();
  return { id: row.id, vendor, period, ref, totalCents, status: "read", counted: true, warning };
}

export async function recentInvoices(limit = 60) {
  const rows = await prisma.vendorInvoice.findMany({ orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: limit });
  return rows.map((r) => ({ id: r.id, vendor: r.vendor, period: r.period, ref: r.ref, invoiceNumber: r.invoiceNumber, origin: r.origin, fileKey: r.fileKey, totalCents: r.totalCents, currency: r.currency, status: r.status, error: r.error, lineCount: Array.isArray(r.lines) ? r.lines.length : 0, at: r.updatedAt.toISOString() }));
}
