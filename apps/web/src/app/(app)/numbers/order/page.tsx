import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { requireClientWorkspace } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { Badge, Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { NumbersCard } from "@/components/numbers-card";
import { orderSelected } from "../actions";
import { Flash, param, provisionStatus, setupComplete, type Found } from "../parts";

/**
 * Order tab: search an area code and buy, plan numbers for a list (the same
 * card as the list page and the campaign's Dialing tab), and the order
 * history. Split out of /numbers on 7 Nov; the actions are unchanged.
 */
export default async function OrderPage({ searchParams }: PageProps<"/numbers/order">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const campaignPick = param(sp, "campaign");
  const planPick = param(sp, "plan");
  const areaCode = param(sp, "areaCode").replace(/\D/g, "").slice(0, 3);
  const qty = Math.min(50, Math.max(1, Number(param(sp, "qty")) || 10));

  const [campaigns, lists, orders, { status, error: statusError }] = await Promise.all([
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.list.findMany({
      where: { tenantId: s.tenant.id, campaignId: { not: null }, campaign: { status: { not: "ARCHIVED" } } },
      orderBy: [{ campaign: { name: "asc" } }, { name: "asc" }],
      select: { id: true, name: true, totalLeads: true, campaign: { select: { id: true, name: true } } },
      take: 200,
    }),
    prisma.numberOrder.findMany({ where: { tenantId: s.tenant.id }, orderBy: { createdAt: "desc" }, take: 20, include: { campaign: { select: { name: true } }, _count: { select: { numbers: true } } } }),
    provisionStatus(s.tenant.id),
  ]);
  const setupDone = setupComplete(status);
  const planned = lists.find((l) => l.id === planPick) ?? null;

  let found: Found[] = [];
  let searchError: string | null = null;
  if (areaCode.length === 3 && setupDone) {
    try {
      found = await engine<Found[]>("/provision/search", { method: "POST", body: JSON.stringify({ areaCode, limit: qty }) });
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div>
      <PageHeader title="Order numbers" subtitle="Buy local numbers by area code, or let a list work out what it needs. New numbers attach to the voice trunk and texting profile and register in jambonz on their own." />
      <Flash sp={sp} engineError={statusError} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <Card title="Search and buy">
            {!setupDone && status ? (
              <Notice kind="warn">
                Run the{" "}
                <NavLink href="/numbers/carrier" className="underline">
                  carrier setup
                </NavLink>{" "}
                first; ordered numbers need the connection and profile to attach to.
              </Notice>
            ) : null}
            <div className="@container">
              <form method="GET" className="grid grid-cols-2 items-end gap-3 @min-[560px]:grid-cols-[110px_110px_minmax(0,1fr)_auto]">
                <Field label="Area code">
                  <input name="areaCode" defaultValue={areaCode} maxLength={3} pattern="\d{3}" className={inputClass} placeholder="305" required />
                </Field>
                <Field label="How many">
                  <input name="qty" type="number" min={1} max={50} defaultValue={qty} className={inputClass} />
                </Field>
                <div className="col-span-2 @min-[560px]:col-span-1">
                  <Field label="For campaign">
                    <select name="campaign" defaultValue={campaignPick} className={inputClass}>
                      <option value="">Shared pool (any campaign)</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Button type="submit" variant="ghost" disabled={!setupDone}>
                  Search
                </Button>
              </form>
            </div>
            {searchError ? <div className="mt-3"><Notice kind="error">{searchError}</Notice></div> : null}
            {found.length > 0 ? (
              <form action={orderSelected} className="mt-4">
                <input type="hidden" name="campaignId" value={campaignPick} />
                <input type="hidden" name="areaCode" value={areaCode} />
                <div className="max-h-[34vh] divide-y divide-zinc-800 overflow-y-auto rounded-md border border-zinc-800">
                  {found.map((n) => (
                    <label key={n.e164} className="flex items-center gap-3 px-3 py-1.5 text-sm hover:bg-zinc-800/50">
                      <input type="checkbox" name="phones" value={n.phone} defaultChecked className="h-4 w-4 shrink-0" />
                      <span className="w-32 shrink-0 font-mono">{formatPhone(n.phone)}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-300">
                        {n.city ?? "–"}
                        {n.state ? `, ${n.state}` : ""}
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-300">{n.monthly ? `$${n.monthly}` : "–"}</span>
                      <span className="hidden shrink-0 text-xs text-zinc-500 sm:inline">{n.features.join(", ")}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button type="submit" className="bg-emerald-400 text-emerald-950 hover:bg-emerald-300">
                    Buy the checked numbers
                  </Button>
                  <span className="min-w-0 flex-1 text-xs text-zinc-500">
                    Each joins the pool{campaignPick ? " pinned to the chosen campaign" : ""}. New numbers start unregistered at the Free Caller Registry and will not dial until marked registered on the Reputation tab.
                  </span>
                </div>
              </form>
            ) : areaCode.length === 3 && !searchError && setupDone ? (
              <p className="mt-3 text-sm text-zinc-500">Nothing available in {areaCode} right now with voice and SMS. Try a neighbouring area code.</p>
            ) : null}
          </Card>

          <Card title="Plan numbers for a list">
            {lists.length === 0 ? (
              <p className="text-sm text-zinc-500">No list is in a live campaign yet. Attach a list to a campaign and it plans the numbers its leads need here, on the list page and on the campaign&apos;s Dialing tab.</p>
            ) : (
              <>
                <form method="GET" className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <Field label="List">
                      <select name="plan" defaultValue={planned?.id ?? ""} className={inputClass}>
                        <option value="">Pick a list…</option>
                        {lists.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.campaign?.name} · {l.name} ({l.totalLeads.toLocaleString()} leads)
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Button type="submit" variant="ghost">
                    Plan
                  </Button>
                </form>
                {planned?.campaign ? (
                  <div className="mt-4">
                    <NumbersCard key={`${planned.id}-${planned.totalLeads}`} campaignId={planned.campaign.id} listId={planned.id} />
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-zinc-500">Counts the list&apos;s dialable leads per area code, takes what the pool can lend and orders the rest for local presence. The button acts at once, with a confirm.</p>
                )}
              </>
            )}
          </Card>
        </div>

        <Card title={`Orders (${orders.length})`} className="min-w-0 self-start">
          {orders.length === 0 ? (
            <p className="text-sm text-zinc-500">No orders yet.</p>
          ) : (
            <div className="max-h-[68vh] space-y-2 overflow-y-auto text-sm">
              {orders.map((o) => (
                <div key={o.id} className="rounded-md border border-zinc-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      {o.quantity} × {o.areaCode} {o.campaign ? `· ${o.campaign.name}` : "· shared pool"}
                    </span>
                    <Badge tone={o.status === "success" ? "green" : o.status === "pending" ? "amber" : "red"}>{o.status}</Badge>
                  </div>
                  <div className="mt-1 break-words text-xs text-zinc-500">
                    {o.createdAt.toLocaleString()} · {o._count.numbers} numbers · {o.requestedBy ?? ""}
                  </div>
                  {o.error ? <div className="mt-1 break-words text-xs text-red-300">{o.error}</div> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
