// CSV of the /platform accounting for a month: ?what=clients (the P&L per
// client) or ?what=vendors (spend by vendor and kind, this month and last).
// Platform admins only.
import { toCsv } from "@strowger/shared/accounting";
import { requireRole } from "@/lib/auth";
import { platformAccounting } from "@/lib/billing-actions";

export const dynamic = "force-dynamic";

const usd = (cents: number) => (cents / 100).toFixed(2);

export async function GET(req: Request) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) return new Response("Platform workspace only", { status: 403 });
  const q = new URL(req.url).searchParams;
  const a = await platformAccounting(q.get("period") ?? undefined);
  const what = q.get("what") === "vendors" ? "vendors" : "clients";
  let body: string;
  if (what === "vendors") {
    body = toCsv(
      ["vendor", "kind", "source", "records", "quantity", `cost_${a.period}_usd`, `cost_${a.lastPeriod}_usd`],
      a.vendors.map((v) => [v.vendor, v.kind, v.source, v.records, Math.round(v.quantity * 100) / 100, usd(v.thisCents), usd(v.lastCents)]),
    );
  } else {
    const vendors = [...new Set(a.clients.flatMap((c) => Object.keys(c.costByVendorCents)))].sort();
    body = toCsv(
      ["client", "seats", "minutes", "numbers", "texts", "revenue_usd", ...vendors.map((v) => `cost_${v}_usd`), "shared_fixed_allocated_usd", "unmatched_allocated_usd", "cost_usd", "margin_usd", "margin_pct", "below_floor"],
      [
        ...a.clients.map((c) => [c.name, c.seats, c.minutes, c.numbers, c.texts, usd(c.revenueCents), ...vendors.map((v) => usd(c.costByVendorCents[v] ?? 0)), usd(c.fixedAllocatedCents), usd(c.unmatchedAllocatedCents), usd(c.costCents), usd(c.marginCents), c.marginPct, c.belowFloor ? "yes" : "no"]),
        ["Shared cost not allocated", "", "", "", "", "", ...vendors.map(() => ""), "", "", usd(a.unallocatedCents), "", "", ""],
        ["Platform own use", "", "", "", "", "", ...vendors.map(() => ""), "", "", usd(a.platformOwnCents), "", "", ""],
        ["All vendors (what we paid)", "", "", "", "", usd(a.top.revenueCents), ...vendors.map(() => ""), "", "", usd(a.top.costCents), usd(a.top.marginCents), a.top.marginPct, ""],
      ],
    );
  }
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="strowger-${what}-${a.period}.csv"` } });
}
