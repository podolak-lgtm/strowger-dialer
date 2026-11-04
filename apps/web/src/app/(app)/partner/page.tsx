// The affiliate's own view: how their posted leads are doing. Counts and
// rates only; the phone numbers and names they sent are theirs to see, but
// nothing about other partners or the agents.
import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { requireRole } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader, Table, Td } from "@/components/ui";

export default async function PartnerPage() {
  const s = await requireRole("AFFILIATE");
  const affiliate = s.user.affiliateId ? await prisma.affiliate.findFirst({ where: { id: s.user.affiliateId, tenantId: s.tenant.id }, include: { lists: { include: { campaign: { select: { name: true, status: true } } } } } }) : null;
  if (!affiliate) {
    return (
      <div>
        <PageHeader title="Partner portal" />
        <Empty>Your account is not linked to a partner yet. Ask your contact at {s.tenant.name} to link it on the People page.</Empty>
      </div>
    );
  }
  const listIds = affiliate.lists.map((l) => l.id);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

  const [posted, postedEvents, recent] = await Promise.all([
    prisma.lead.findMany({ where: { listId: { in: listIds } }, select: { postedAt: true, status: true, scrubStatus: true, calls: { select: { bridgedAt: true, disposition: { select: { isSale: true, isContact: true } } } } } }),
    prisma.leadEvent.findMany({ where: { lead: { listId: { in: listIds } }, kind: "NOTE", createdAt: { gte: monthAgo } }, select: { data: true, createdAt: true } }),
    prisma.lead.findMany({ where: { listId: { in: listIds } }, orderBy: { postedAt: "desc" }, take: 25, include: { list: { select: { name: true } } } }),
  ]);
  const window = (since: Date) => posted.filter((l) => l.postedAt >= since);
  const dup = (since: Date) => postedEvents.filter((e) => e.createdAt >= since && (e.data as { duplicate?: string }).duplicate).length;
  const stat = (since: Date) => {
    const rows = window(since);
    const contacted = rows.filter((l) => l.calls.some((c) => c.bridgedAt)).length;
    const sales = rows.filter((l) => l.calls.some((c) => c.disposition?.isSale)).length;
    const rejected = rows.filter((l) => l.status === "DNC" || l.status === "BLOCKED").length;
    return { accepted: rows.length - rejected, rejected, duplicates: dup(since), contacted, sales, contactRate: rows.length ? Math.round((contacted / rows.length) * 1000) / 10 : 0 };
  };
  const periods = [
    ["Last 24 hours", stat(dayAgo)],
    ["Last 7 days", stat(weekAgo)],
    ["Last 30 days", stat(monthAgo)],
  ] as const;

  return (
    <div>
      <PageHeader title={affiliate.name} subtitle={`Partner portal · ${s.tenant.name} · key ${affiliate.apiKeyHint}`} />
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {periods.map(([label, p]) => (
          <Card key={label} title={label}>
            <div className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ["Accepted", p.accepted, "green"],
                  ["Duplicates", p.duplicates, "zinc"],
                  ["Rejected", p.rejected, "red"],
                  ["Contacted", p.contacted, "blue"],
                  ["Sales", p.sales, "green"],
                  ["Contact rate", `${p.contactRate}%`, "zinc"],
                ] as const
              ).map(([k, v, tone]) => (
                <div key={k}>
                  <div className="text-2xl font-semibold tabular-nums">{v}</div>
                  <Badge tone={tone}>{k}</Badge>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Your lists">
          {affiliate.lists.map((l) => (
            <div key={l.id} className="flex items-center justify-between border-b border-zinc-800 py-2 text-sm last:border-0">
              <div>
                <div>{l.name}</div>
                <div className="text-xs text-zinc-500">{l.campaign ? `${l.campaign.name} · ${l.campaign.status.toLowerCase()}` : "not in a campaign yet"}</div>
              </div>
              <div className="tabular-nums text-zinc-300">{l.totalLeads.toLocaleString()}</div>
            </div>
          ))}
        </Card>
        <Card title="Most recent posts" className="lg:col-span-2">
          <Table head={["Posted", "Phone", "Name", "State", "List", "Status"]}>
            {recent.map((l) => (
              <tr key={l.id}>
                <Td className="text-xs text-zinc-400">{l.postedAt.toLocaleString("en-US", { timeZone: "UTC" })} UTC</Td>
                <Td className="font-mono text-xs">{formatPhone(l.phone)}</Td>
                <Td>
                  {l.firstName} {l.lastName}
                </Td>
                <Td>{l.state}</Td>
                <Td className="text-xs text-zinc-400">{l.list.name}</Td>
                <Td>
                  <Badge tone={l.status === "DNC" || l.status === "BLOCKED" ? "red" : l.status === "CONTACTED" || l.status === "FINISHED" ? "green" : "blue"}>{l.status === "BLOCKED" ? "rejected" : l.status.toLowerCase()}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
