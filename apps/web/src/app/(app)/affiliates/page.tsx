import { prisma } from "@strowger/db";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { createAffiliate } from "./actions";

export default async function AffiliatesPage() {
  const s = await requireClientWorkspace("SUPERVISOR");
  const affiliates = await prisma.affiliate.findMany({
    where: { tenantId: s.tenant.id },
    orderBy: { createdAt: "desc" },
    include: { lists: { select: { id: true, name: true, totalLeads: true, campaign: { select: { name: true } } } } },
  });

  return (
    <div>
      <PageHeader title="Affiliates" subtitle="Partners who post leads to you. Each gets a key, a list of its own, and posting instructions." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {affiliates.length === 0 ? (
            <Empty>No affiliates yet. Create one and send them the posting instructions.</Empty>
          ) : (
            <Table head={["Affiliate", "Key", "Lists", "Status"]}>
              {affiliates.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link href={`/affiliates/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs text-zinc-400">{a.apiKeyHint}</Td>
                  <Td>
                    {a.lists.map((l) => (
                      <div key={l.id} className="text-xs text-zinc-400">
                        {l.name} · {l.totalLeads} leads{l.campaign ? ` · ${l.campaign.name}` : " · no campaign"}
                      </div>
                    ))}
                  </Td>
                  <Td>{a.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Disabled</Badge>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <Card title="New affiliate">
          <form action={createAffiliate} className="space-y-4">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Acme Leads LLC" />
            </Field>
            <Button type="submit">Create and show key</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
