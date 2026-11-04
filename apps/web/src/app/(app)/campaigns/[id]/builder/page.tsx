import { prisma } from "@strowger/db";
import { parseAllowedHours } from "@strowger/shared/compliance";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { Builder } from "./builder";

export default async function BuilderPage({ params }: PageProps<"/campaigns/[id]/builder">) {
  const s = await requireRole("SUPERVISOR");
  const { id } = await params;
  const [c, cadences, unattached] = await Promise.all([
    prisma.campaign.findFirst({
      where: { id, tenantId: s.tenant.id },
      include: { lists: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }], include: { cadence: true, _count: { select: { leads: true } } } } },
    }),
    prisma.cadenceProfile.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" } }),
    prisma.list.findMany({ where: { tenantId: s.tenant.id, campaignId: null, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true, totalLeads: true } }),
  ]);
  if (!c) notFound();

  return (
    <Builder
      campaign={{ id: c.id, name: c.name, status: c.status, dialMode: c.dialMode, maxAttemptsPerDay: c.maxAttemptsPerDay, listSelection: c.listSelection, localWindowStart: c.localWindowStart, localWindowEnd: c.localWindowEnd }}
      lists={c.lists.map((l) => ({
        id: l.id,
        name: l.name,
        priority: l.priority,
        status: l.status,
        source: l.source,
        total: l.totalLeads,
        dialable: l.dialableLeads,
        cadence: l.cadence ? { id: l.cadence.id, name: l.cadence.name, kind: l.cadence.kind, instantDial: l.cadence.instantDial, instantDelaySeconds: l.cadence.instantDelaySeconds, maxAttemptsPerDay: l.cadence.maxAttemptsPerDay, minGapMinutes: l.cadence.minGapMinutes, rotateDayparts: l.cadence.rotateDayparts, preCallSms: l.cadence.preCallSms, missedCallSms: l.cadence.missedCallSms } : null,
      }))}
      cadences={cadences.map((x) => ({ id: x.id, name: x.name, kind: x.kind }))}
      unattached={unattached}
      grid={parseAllowedHours(c.allowedHours)}
    />
  );
}
