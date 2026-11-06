import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateFocus,
  dollarsToMillicents,
  extractEmailCode,
  invoiceFileKey,
  invoiceKey,
  invoiceMode,
  invoicePeriod,
  isVendorFileKey,
  monthRowCounts,
  nightlyDue,
  nightlySummary,
  periodKey,
  railwayCostMillicents,
  secretHint,
  sniffInvoiceFile,
  winningClass,
} from "./vendor-collect";

test("invoice beats the API's running month total, which beats a fixed cost", () => {
  assert.equal(winningClass(["fixed"]), "fixed");
  assert.equal(winningClass(["fixed", "period"]), "period");
  assert.equal(winningClass(["period", "invoice", "fixed"]), "invoice");
  assert.equal(winningClass([]), null);
});

test("an invoice for a vendor and month skips that month's fixed cost (no double count)", () => {
  // Clerk: fixed $25 entered, invoice read for October. Only the invoice counts.
  assert.equal(monthRowCounts("clerk", "fixed", ["invoice"]), false);
  assert.equal(monthRowCounts("clerk", "invoice", ["fixed"]), true);
  // No invoice yet: the fixed row counts.
  assert.equal(monthRowCounts("clerk", "fixed", []), true);
  // Railway: the API running total replaces the fixed estimate, and the invoice replaces both.
  assert.equal(monthRowCounts("railway", "fixed", ["period"]), false);
  assert.equal(monthRowCounts("railway", "period", ["fixed"]), true);
  assert.equal(monthRowCounts("railway", "period", ["invoice", "fixed"]), false);
});

test("vendors counted per event never get invoice rows (their invoice is reconciliation only)", () => {
  assert.equal(invoiceMode("telnyx"), "reconcile");
  assert.equal(invoiceMode("Anthropic"), "reconcile");
  assert.equal(invoiceMode("jambonz"), "replaces");
  assert.equal(monthRowCounts("telnyx", "invoice", []), false);
  // A Telnyx invoice does not knock out a Telnyx fixed fee (10DLC) either.
  assert.equal(monthRowCounts("telnyx", "fixed", ["invoice"]), true);
});

test("keys", () => {
  assert.equal(invoiceKey("Clerk", "INV-0042", "2026-10"), "invoice:clerk:INV-0042");
  assert.equal(invoiceKey("clerk", null, "2026-10"), "invoice:clerk:2026-10");
  assert.equal(invoiceKey("clerk", "  ", "2026-10", 2), "invoice:clerk:2026-10:2");
  assert.equal(invoiceKey("clerk", "A/B C", "2026-10"), "invoice:clerk:A_B_C");
  assert.equal(periodKey("2026-11", "svc 1"), "period:2026-11:svc_1");
  assert.equal(invoiceFileKey("jambonz", "2026-10", "pdf"), "vendor-invoices/jambonz/2026-10.pdf");
  assert.equal(invoiceFileKey("jambonz", "2026-10", "pdf", "in_123"), "vendor-invoices/jambonz/2026-10-in_123.pdf");
  assert.ok(isVendorFileKey("vendor-invoices/jambonz/2026-10.pdf"));
  assert.ok(isVendorFileKey("vendor-screens/clerk/x.png"));
  assert.ok(!isVendorFileKey("audio/t/abc.wav"));
});

test("an invoice's month is the middle of its service period", () => {
  assert.equal(invoicePeriod("2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z"), "2026-10");
  assert.equal(invoicePeriod("2026-10-05T00:00:00Z", "2026-11-05T00:00:00Z"), "2026-10");
  assert.equal(invoicePeriod("2026-10-25T00:00:00Z", "2026-11-25T00:00:00Z"), "2026-11");
  assert.equal(invoicePeriod(null, null, "2026-09"), "2026-09");
  assert.equal(invoicePeriod(null, "2026-11-01T00:00:00Z"), "2026-10");
  assert.equal(invoicePeriod(null, null, "nope"), null);
});

test("money strings", () => {
  assert.equal(dollarsToMillicents("$1,234.56"), 123_456_000);
  assert.equal(dollarsToMillicents(0.01), 1000);
  assert.equal(dollarsToMillicents("(5.00)"), -500_000);
  assert.equal(dollarsToMillicents("n/a"), null);
  assert.equal(dollarsToMillicents(null), null);
});

test("Vercel FOCUS charges sum by service and project for the month", () => {
  const jsonl = [
    JSON.stringify({ BilledCost: "1.50", ChargeCategory: "Usage", ChargePeriodStart: "2026-11-01T00:00:00Z", ServiceName: "Functions", Tags: { ProjectName: "web" }, ConsumedQuantity: "10" }),
    JSON.stringify({ BilledCost: "0.50", ChargeCategory: "Usage", ChargePeriodStart: "2026-11-02T00:00:00Z", ServiceName: "Functions", Tags: { ProjectName: "web" }, ConsumedQuantity: "5" }),
    JSON.stringify({ BilledCost: "20", ChargeCategory: "Purchase", ChargePeriodStart: "2026-11-01T00:00:00Z", ServiceName: "Pro plan" }),
    JSON.stringify({ BilledCost: "9", ChargePeriodStart: "2026-10-31T00:00:00Z", ServiceName: "Functions", Tags: { ProjectName: "web" } }),
    "not json",
    "",
  ].join("\n");
  const rows = aggregateFocus(jsonl, "2026-11");
  assert.equal(rows.length, 2);
  const fn = rows.find((r) => r.part === "Functions@web")!;
  assert.equal(fn.millicents, 200_000);
  assert.equal(fn.quantity, 15);
  assert.equal(fn.kind, "hosting");
  assert.equal(rows.find((r) => r.part === "Pro plan@team")!.kind, "subscription");
});

test("Railway usage at the published rates", () => {
  // A month of one vCPU and 1 GB: ~$20 + ~$10.
  const minutes = 30 * 24 * 60;
  const mc = railwayCostMillicents({ CPU_USAGE: minutes, MEMORY_USAGE_GB: minutes });
  assert.ok(Math.abs(mc / 100_000 - 29.99) < 0.05, String(mc));
  assert.equal(railwayCostMillicents({ NETWORK_TX_GB: 2 }), 10_000);
  assert.equal(railwayCostMillicents({}), 0);
});

test("sign-in codes in vendor emails", () => {
  assert.equal(extractEmailCode("Your verification code is 482913. It expires in 10 minutes."), "482913");
  assert.equal(extractEmailCode("Subject: Sign in\nUse code: AB12CD to finish signing in"), "AB12CD");
  assert.equal(extractEmailCode("Here is your one-time passcode\n\n 7731 \n"), "7731");
  assert.equal(extractEmailCode("Click https://x.example/verify?code=999999 to continue. Code 123456"), "123456");
  assert.equal(extractEmailCode("Welcome to the newsletter"), null);
});

test("secrets show only their last four characters", () => {
  assert.equal(secretHint("sk_live_abcdef1234"), "saved, ending …1234");
  assert.equal(secretHint("abc"), "saved");
  assert.equal(secretHint(""), null);
});

test("invoice files: PDF by its magic bytes, CSV by name and text", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(sniffInvoiceFile("x.pdf", "application/pdf", pdf), "pdf");
  assert.equal(sniffInvoiceFile("x.bin", null, pdf), "pdf");
  assert.equal(sniffInvoiceFile("fake.pdf", "application/pdf", new TextEncoder().encode("hello")), null);
  assert.equal(sniffInvoiceFile("usage.csv", "text/csv", new TextEncoder().encode("a,b\n1,2")), "csv");
  assert.equal(sniffInvoiceFile("usage.csv", "text/csv", new Uint8Array([0, 1, 2])), null);
  assert.equal(sniffInvoiceFile("photo.png", "image/png", new Uint8Array([0x89, 0x50])), null);
});

test("the nightly run is due once a day from 07:00 UTC", () => {
  assert.equal(nightlyDue(new Date("2026-11-07T06:59:00Z"), "2026-11-06"), false);
  assert.equal(nightlyDue(new Date("2026-11-07T07:00:00Z"), "2026-11-06"), true);
  assert.equal(nightlyDue(new Date("2026-11-07T15:00:00Z"), "2026-11-07"), false);
  assert.equal(nightlyDue(new Date("2026-11-07T15:00:00Z"), null), true);
});

test("the admins are emailed only when something failed or a balance is low", () => {
  const ok = [{ vendor: "railway", label: "Railway", status: "ok" as const }];
  assert.equal(nightlySummary(ok, [{ label: "Telnyx", balanceCents: 50_000, lowBalanceCents: 10_000 }]), null);
  const s = nightlySummary([...ok, { vendor: "clerk", label: "Clerk", status: "needs_person", error: "CAPTCHA on the sign-in page" }], [{ label: "Telnyx", balanceCents: 9_000, lowBalanceCents: 10_000 }])!;
  assert.match(s.subject, /1 collection need attention, 1 low balance/);
  assert.deepEqual(s.lines, ["Clerk: needs a person (CAPTCHA on the sign-in page).", "Telnyx balance is $90.00, at or under its $100.00 line."]);
});
