import { prisma } from "@strowger/db";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { createList } from "./actions";

const statusTone = { IMPORTING: "blue", ACTIVE: "green", PAUSED: "amber", ARCHIVED: "zinc" } as const;

export default async function ListsPage() {
  const s = await requireRole("SUPERVISOR");
  const [lists, campaigns] = await Promise.all([
    prisma.list.findMany({
      where: { tenantId: s.tenant.id },
      orderBy: { createdAt: "desc" },
      include: { campaign: { select: { id: true, name: true } }, affiliate: { select: { name: true } } },
    }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div>
      <PageHeader title="Lists" subtitle="Data you load or that affiliates post. A list belongs to one campaign at a time; a campaign can hold many lists." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {lists.length === 0 ? (
            <Empty>No lists yet. Create one and upload a CSV, or create an affiliate to receive posted leads.</Empty>
          ) : (
            <Table head={["List", "Source", "Campaign", "Leads", "Dialable", "Status"]}>
              {lists.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <Link href={`/lists/${l.id}`} className="font-medium hover:underline">
                      {l.name}
                    </Link>
                  </Td>
                  <Td className="text-zinc-400">{l.source === "POST" ? `Posted · ${l.affiliate?.name ?? ""}` : "Upload"}</Td>
                  <Td>{l.campaign ? <Link href={`/campaigns/${l.campaign.id}`} className="hover:underline">{l.campaign.name}</Link> : <span className="text-zinc-500">none</span>}</Td>
                  <Td className="tabular-nums">{l.totalLeads.toLocaleString()}</Td>
                  <Td className="tabular-nums">{l.dialableLeads.toLocaleString()}</Td>
                  <Td>
                    <Badge tone={statusTone[l.status]}>{l.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <Card title="New list">
          <form action={createList} className="space-y-4">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="November solar leads" />
            </Field>
            <Field label="Campaign" hint="Can be set later.">
              <select name="campaignId" className={inputClass} defaultValue="">
                <option value="">No campaign yet</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit">Create list</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
