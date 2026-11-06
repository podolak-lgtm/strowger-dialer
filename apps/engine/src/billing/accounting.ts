// The owner's accounting view for one month (/platform): revenue per client
// from the ledger (BillingEntry charges), cost from VendorUsage, shared costs
// spread by the rule in PlatformRates.costAllocation, and the vendor table for
// this month and the last. The maths is in @strowger/shared/accounting.
import { prisma } from "@strowger/db";
import { buildPnl, isPeriod, marginOf, prevPeriod, type CostAllocation } from "@strowger/shared/accounting";
import { inTrial } from "@strowger/shared/referrals";
import { period as currentPeriod, rates } from "./index";
import { materialiseFixedCosts, vendorAccounts } from "./vendor";

const toCents = (mc: number) => Math.round(mc / 1000);

export async function platformAccounting(p?: string) {
  const period = isPeriod(p) ? p : currentPeriod();
  const last = prevPeriod(period);
  const r = await rates();
  const rule: CostAllocation = r.costAllocation === "SEATS" ? "SEATS" : "MINUTES";
  const inPeriod = { startsWith: period };

  const [tenants, charges, cats, usage, numbers, vendorThis, vendorLast, fixedCosts, accounts] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true, name: true, slug: true, isPlatform: true, trialStartedAt: true, trialEndsAt: true, trialConvertedAt: true, billing: { select: { balanceCents: true, suspended: true } } }, orderBy: { name: "asc" } }),
    prisma.billingEntry.groupBy({ by: ["tenantId"], where: { period, kind: "CHARGE" }, _sum: { amountCents: true } }),
    prisma.billingEntry.groupBy({ by: ["tenantId", "category"], where: { period, kind: "CHARGE", category: { in: ["SEAT", "MINUTES", "SMS"] } }, _sum: { quantity: true }, _count: { _all: true } }),
    prisma.vendorUsage.groupBy({ by: ["tenantId", "vendor", "source"], where: { day: inPeriod }, _sum: { costMillicents: true } }),
    prisma.vendorUsage.groupBy({ by: ["tenantId"], where: { day: inPeriod, vendor: "telnyx", kind: "number" }, _count: { _all: true } }),
    prisma.vendorUsage.groupBy({ by: ["vendor", "kind", "source"], where: { day: inPeriod }, _sum: { costMillicents: true, quantity: true }, _count: { _all: true } }),
    prisma.vendorUsage.groupBy({ by: ["vendor", "kind", "source"], where: { day: { startsWith: last } }, _sum: { costMillicents: true, quantity: true }, _count: { _all: true } }),
    prisma.vendorFixedCost.findMany({ orderBy: [{ vendor: "asc" }, { label: "asc" }] }),
    vendorAccounts(),
  ]);

  const platformIds = new Set(tenants.filter((t) => t.isPlatform).map((t) => t.id));
  const clients = tenants.filter((t) => !t.isPlatform);
  const cat = (tenantId: string, c: string) => cats.find((x) => x.tenantId === tenantId && x.category === c);
  let sharedFixedMc = 0;
  let unattributedMc = 0;
  let platformOwnMc = 0;
  let totalCostMc = 0;
  for (const u of usage) {
    const mc = u._sum.costMillicents ?? 0;
    totalCostMc += mc;
    if (u.tenantId === null) {
      if (u.source === "fixed") sharedFixedMc += mc;
      else unattributedMc += mc;
    } else if (platformIds.has(u.tenantId)) platformOwnMc += mc;
  }

  const pnl = buildPnl({
    clients: clients.map((t) => {
      const byVendor: Record<string, number> = {};
      for (const u of usage) if (u.tenantId === t.id) byVendor[u.vendor] = (byVendor[u.vendor] ?? 0) + (u._sum.costMillicents ?? 0);
      return {
        id: t.id,
        name: t.name,
        seats: cat(t.id, "SEAT")?._count._all ?? 0,
        minutes: Math.round(Number(cat(t.id, "MINUTES")?._sum.quantity ?? 0) * 10) / 10,
        numbers: numbers.find((n) => n.tenantId === t.id)?._count._all ?? 0,
        texts: Math.round(Number(cat(t.id, "SMS")?._sum.quantity ?? 0)),
        revenueCents: -(charges.find((c) => c.tenantId === t.id)?._sum.amountCents ?? 0),
        costByVendorMillicents: byVendor,
      };
    }),
    sharedFixedMillicents: sharedFixedMc,
    unattributedMillicents: unattributedMc,
    rule,
    allocateUnattributed: r.allocateUnattributed,
    floorPct: r.marginFloorPct,
  });

  const now = new Date();
  const revenueCents = pnl.totals.revenueCents;
  const costCents = toCents(totalCostMc);
  const key = (x: { vendor: string; kind: string; source: string }) => `${x.vendor}\u0000${x.kind}\u0000${x.source}`;
  const vendorKeys = new Set([...vendorThis.map(key), ...vendorLast.map(key)]);
  const vendorRows = [...vendorKeys]
    .map((k) => {
      const [vendor, kind, source] = k.split("\u0000") as [string, string, string];
      const a = vendorThis.find((x) => key(x) === k);
      const b = vendorLast.find((x) => key(x) === k);
      return { vendor, kind, source, thisMillicents: a?._sum.costMillicents ?? 0, thisCents: toCents(a?._sum.costMillicents ?? 0), lastCents: toCents(b?._sum.costMillicents ?? 0), quantity: Number(a?._sum.quantity ?? 0), records: a?._count._all ?? 0 };
    })
    .sort((x, y) => x.vendor.localeCompare(y.vendor) || y.thisCents - x.thisCents);

  return {
    period,
    lastPeriod: last,
    settings: { costAllocation: rule, allocateUnattributed: r.allocateUnattributed, marginFloorPct: r.marginFloorPct, ttsCostMillicentsPerKChar: r.ttsCostMillicentsPerKChar },
    top: { revenueCents, costCents, ...marginOf(revenueCents, costCents), prepaidHeldCents: clients.reduce((n, t) => n + (t.billing?.balanceCents ?? 0), 0) },
    clients: pnl.rows.map((row) => {
      const t = clients.find((c) => c.id === row.id)!;
      return { ...row, slug: t.slug, trial: inTrial(t, now), balanceCents: t.billing?.balanceCents ?? 0, suspended: t.billing?.suspended ?? false };
    }),
    clientTotals: pnl.totals,
    sharedFixedCents: toCents(sharedFixedMc),
    unattributedCents: toCents(unattributedMc),
    unallocatedCents: toCents(pnl.unallocatedMillicents),
    platformOwnCents: toCents(platformOwnMc),
    vendors: vendorRows,
    vendorTotals: { thisCents: vendorRows.reduce((n, v) => n + v.thisCents, 0), lastCents: vendorRows.reduce((n, v) => n + v.lastCents, 0) },
    accounts,
    fixedCosts: fixedCosts.map((c) => ({ id: c.id, tenantId: c.tenantId, tenantName: tenants.find((t) => t.id === c.tenantId)?.name ?? null, vendor: c.vendor, kind: c.kind, label: c.label, amountCents: c.amountCents, cadence: c.cadence, startPeriod: c.startPeriod, endPeriod: c.endPeriod, note: c.note })),
    tenants: clients.map((t) => ({ id: t.id, name: t.name })),
  };
}

export interface FixedCostInput {
  id?: string | null;
  tenantId: string | null;
  vendor: string;
  kind: string;
  label: string;
  amountCents: number;
  cadence: "MONTHLY" | "ONCE";
  startPeriod: string;
  endPeriod: string | null;
  note: string | null;
}

export async function saveFixedCost(i: FixedCostInput): Promise<string> {
  if (!isPeriod(i.startPeriod)) throw new Error("Start month must be YYYY-MM");
  if (i.endPeriod && (!isPeriod(i.endPeriod) || i.endPeriod < i.startPeriod)) throw new Error("End month must be YYYY-MM, not before the start");
  const data = { tenantId: i.tenantId, vendor: i.vendor.trim().toLowerCase(), kind: i.kind.trim() || "subscription", label: i.label.trim(), amountCents: i.amountCents, cadence: i.cadence, startPeriod: i.startPeriod, endPeriod: i.cadence === "ONCE" ? null : i.endPeriod, note: i.note };
  const row = i.id ? await prisma.vendorFixedCost.update({ where: { id: i.id }, data }) : await prisma.vendorFixedCost.create({ data });
  await materialiseFixedCosts();
  return row.id;
}

export async function deleteFixedCost(id: string): Promise<void> {
  await prisma.vendorFixedCost.delete({ where: { id } });
  await materialiseFixedCosts();
}

export async function saveAccountingSettings(i: { costAllocation: CostAllocation; allocateUnattributed: boolean; marginFloorPct: number; ttsCostMillicentsPerKChar: number }): Promise<void> {
  await rates();
  await prisma.platformRates.update({ where: { id: "default" }, data: i });
}
