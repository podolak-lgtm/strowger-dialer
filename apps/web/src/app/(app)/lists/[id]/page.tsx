import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { updateList } from "../actions";
import { rememberedMappings } from "../import-actions";
import { UploadWizard } from "./upload-wizard";

export default async function ListPage({ params }: PageProps<"/lists/[id]">) {
  const s = await requireRole("SUPERVISOR");
  const { id } = await params;
  const [list, campaigns, remembered] = await Promise.all([
    prisma.list.findFirst({
      where: { id, tenantId: s.tenant.id },
      include: {
        campaign: { select: { id: true, name: true } },
        affiliate: { select: { id: true, name: true } },
        imports: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    rememberedMappings(),
  ]);
  if (!list) notFound();

  const [byStatus, recent] = await Promise.all([
    prisma.lead.groupBy({ by: ["status"], where: { listId: list.id }, _count: { _all: true } }),
    prisma.lead.findMany({ where: { listId: list.id }, orderBy: { postedAt: "desc" }, take: 25 }),
  ]);

  return (
    <div>
      <PageHeader
        title={list.name}
        subtitle={
          <>
            {list.source === "POST" ? `Posted by ${list.affiliate?.name}` : "Uploaded"} · {list.totalLeads.toLocaleString()} leads ·{" "}
            {list.campaign ? `in ${list.campaign.name}` : "not in a campaign"}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {list.source === "UPLOAD" ? (
            <Card title="Upload CSV">
              <UploadWizard listId={list.id} remembered={remembered} />
            </Card>
          ) : null}

          <Card title="Leads by status">
            <div className="flex flex-wrap gap-2">
              {byStatus.length === 0 ? <span className="text-sm text-zinc-500">None yet.</span> : null}
              {byStatus.map((b) => (
                <div key={b.status} className="rounded-md border border-zinc-800 px-3 py-2 text-sm">
                  <span className="font-semibold tabular-nums">{b._count._all.toLocaleString()}</span> <span className="text-zinc-400">{b.status}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Most recent leads">
            <Table head={["Phone", "Name", "Location", "Zone", "Status", "Posted"]}>
              {recent.map((l) => (
                <tr key={l.id}>
                  <Td className="font-mono text-xs">{formatPhone(l.phone)}</Td>
                  <Td>
                    {l.firstName} {l.lastName}
                  </Td>
                  <Td className="text-zinc-400">
                    {l.city ? `${l.city}, ` : ""}
                    {l.state} {l.zip}
                  </Td>
                  <Td className="text-xs text-zinc-400">{l.timezone ?? <Badge tone="amber">unknown</Badge>}</Td>
                  <Td>
                    <Badge tone={l.status === "DNC" || l.status === "BLOCKED" ? "red" : l.status === "NEW" ? "blue" : "zinc"}>{l.status}</Badge>
                  </Td>
                  <Td className="text-xs text-zinc-500">{l.postedAt.toLocaleString("en-US", { timeZone: "UTC" })} UTC</Td>
                </tr>
              ))}
            </Table>
          </Card>

          {list.imports.length > 0 ? (
            <Card title="Imports">
              <Table head={["File", "Rows", "Accepted", "Duplicates", "Bad phone", "DNC", "Status"]}>
                {list.imports.map((i) => (
                  <tr key={i.id}>
                    <Td>{i.fileName}</Td>
                    <Td className="tabular-nums">{i.totalRows}</Td>
                    <Td className="tabular-nums text-emerald-300">{i.acceptedRows}</Td>
                    <Td className="tabular-nums">{i.duplicateRows}</Td>
                    <Td className="tabular-nums text-amber-300">{i.badPhoneRows}</Td>
                    <Td className="tabular-nums text-red-300">{i.dncRows}</Td>
                    <Td>
                      <Badge tone={i.status === "DONE" ? "green" : i.status === "FAILED" ? "red" : "blue"}>{i.status}</Badge>
                      {i.errorReason ? <div className="text-xs text-red-300">{i.errorReason}</div> : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}
        </div>

        <Card title="Settings">
          <form action={updateList} className="space-y-4">
            <input type="hidden" name="id" value={list.id} />
            <Field label="Campaign" hint="Moving a list takes it out of its current campaign.">
              <select name="campaignId" defaultValue={list.campaignId ?? ""} className={inputClass}>
                <option value="">No campaign</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When a phone is already in this list" hint="Duplicates are judged within this list only.">
              <select name="duplicateAction" defaultValue={list.duplicateAction} className={inputClass}>
                <option value="REJECT">Reject the new one</option>
                <option value="ACCEPT">Accept: treat the lead as fresh again</option>
                <option value="UPDATE">Update the existing lead&apos;s details</option>
              </select>
            </Field>
            <Field label="Status">
              <select name="status" defaultValue={list.status} className={inputClass}>
                <option value="ACTIVE">Active</option>
                <option value="PAUSED">Paused (not dialed)</option>
                <option value="ARCHIVED">Archived (no new leads)</option>
              </select>
            </Field>
            <Button type="submit">Save</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
