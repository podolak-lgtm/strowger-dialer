import { prisma } from "@strowger/db";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { createCampaign } from "./actions";

const tone = { DRAFT: "zinc", ACTIVE: "green", PAUSED: "amber", ARCHIVED: "zinc" } as const;

export default async function CampaignsPage() {
  const s = await requireClientWorkspace("SUPERVISOR");
  const campaigns = await prisma.campaign.findMany({
    where: { tenantId: s.tenant.id },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { lists: { select: { totalLeads: true, dialableLeads: true } }, _count: { select: { agents: true } } },
  });

  return (
    <div>
      <PageHeader title="Campaigns" subtitle="What agents log into. Dial mode, pacing, compliance and call handling are set here." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {campaigns.length === 0 ? (
            <Empty>No campaigns yet.</Empty>
          ) : (
            <Table head={["Campaign", "Mode", "Lists", "Leads", "Agents", "Status"]}>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </Td>
                  <Td>
                    {c.dialMode === "RATIO" ? `Ratio ${c.ratio.toString()}:1` : "Preview"}
                  </Td>
                  <Td className="tabular-nums">{c.lists.length}</Td>
                  <Td className="tabular-nums">{c.lists.reduce((n, l) => n + l.totalLeads, 0).toLocaleString()}</Td>
                  <Td className="tabular-nums">{c._count.agents}</Td>
                  <Td>
                    <Badge tone={tone[c.status]}>{c.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <Card title="New campaign">
          <form action={createCampaign} className="space-y-4">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Solar - Florida" />
            </Field>
            <Field label="Dial mode">
              <select name="dialMode" className={inputClass} defaultValue="PREVIEW">
                <option value="PREVIEW">Preview: agent sees the lead, clicks to dial</option>
                <option value="RATIO">Ratio: dialer places N calls per ready agent</option>
              </select>
            </Field>
            <Button type="submit">Create campaign</Button>
          </form>
          <p className="mt-3 text-xs text-zinc-500">Starts as a draft with standard dispositions and a three-step dial plan (day 0, days 1–7, day 8+) you can edit.</p>
        </Card>
      </div>
    </div>
  );
}
