import { prisma } from "@strowger/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";
import { Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { NumbersCard } from "@/components/numbers-card";
import { rememberedMappings } from "../../../lists/import-actions";
import { UploadWizard } from "../../../lists/[id]/upload-wizard";
import { attachFirstList, createFirstList } from "./actions";

// New campaign setup (owner, 6 Nov): Create campaign → the first list (upload
// a new one or pick an existing one; optional) → the numbers it needs, ordered
// and matched for local presence. The campaign page holds everything else.
export default async function CampaignSetupPage({ params, searchParams }: PageProps<"/campaigns/[id]/setup">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const { id } = await params;
  const sp = await searchParams;
  const listId = typeof sp.list === "string" ? sp.list : "";
  const error = typeof sp.error === "string" ? sp.error : "";
  const c = await prisma.campaign.findFirst({ where: { id, tenantId: s.tenant.id }, select: { id: true, name: true } });
  if (!c) notFound();
  const list = listId ? await prisma.list.findFirst({ where: { id: listId, tenantId: s.tenant.id, campaignId: c.id }, select: { id: true, name: true, source: true, totalLeads: true } }) : null;

  const step = (n: number, label: string, on: boolean) => (
    <span className={`rounded-full px-2.5 py-0.5 text-xs ${on ? "bg-sky-500 text-zinc-950" : "bg-zinc-800 text-zinc-400"}`}>
      {n} · {label}
    </span>
  );
  const header = (
    <PageHeader
      title={`Set up ${c.name}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          {step(1, "Campaign", false)} {step(2, "First list", !list)} {step(3, "Numbers", Boolean(list))}
        </span>
      }
      actions={
        <Link href={`/campaigns/${c.id}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
          {list ? "Done: open the campaign" : "Skip for now"}
        </Link>
      }
    />
  );

  if (!list) {
    const lists = await prisma.list.findMany({
      where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" }, OR: [{ campaignId: null }, { campaignId: { not: c.id } }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true, totalLeads: true, campaign: { select: { name: true } } },
      take: 500,
    });
    return (
      <div>
        {header}
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Upload a new list">
            <form action={createFirstList} className="space-y-4">
              <input type="hidden" name="campaignId" value={c.id} />
              <Field label="List name">
                <input name="name" defaultValue={`${c.name} leads`} className={inputClass} required />
              </Field>
              <Button type="submit">Create the list and upload a CSV</Button>
            </form>
          </Card>
          <Card title="Or use a list you already have">
            {lists.length === 0 ? (
              <p className="text-sm text-zinc-500">No other lists yet.</p>
            ) : (
              <form action={attachFirstList} className="space-y-4">
                <input type="hidden" name="campaignId" value={c.id} />
                <Field label="List" hint="A list belongs to one campaign at a time; picking one from another campaign moves it here.">
                  <select name="listId" className={inputClass} required defaultValue="">
                    <option value="" disabled>
                      Pick a list
                    </option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} · {l.totalLeads.toLocaleString()} leads{l.campaign ? ` · now in ${l.campaign.name}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit">Attach it</Button>
              </form>
            )}
          </Card>
        </div>
        <p className="mt-4 text-sm text-zinc-500">Optional: you can attach lists later on the campaign&apos;s Lists tab. Once a list is in, this page works out the caller-ID numbers it needs.</p>
      </div>
    );
  }

  const remembered = list.source === "UPLOAD" ? await rememberedMappings() : {};
  return (
    <div>
      {header}
      <div className="grid gap-6 lg:grid-cols-2">
        {list.source === "UPLOAD" ? (
          <Card title={`Upload CSV into ${list.name}`}>
            <UploadWizard listId={list.id} remembered={remembered} inCampaign />
          </Card>
        ) : null}
        <Card title="Numbers for this list">
          <NumbersCard key={`${list.id}-${list.totalLeads}`} campaignId={c.id} listId={list.id} />
        </Card>
      </div>
      <p className="mt-4 text-sm text-zinc-500">
        {list.name} · {list.totalLeads.toLocaleString()} leads.{" "}
        <Link href={`/campaigns/${c.id}/setup`} className="text-sky-300 underline">
          Add another list
        </Link>{" "}
        ·{" "}
        <Link href={`/campaigns/${c.id}`} className="text-sky-300 underline">
          Open the campaign
        </Link>
      </p>
    </div>
  );
}
