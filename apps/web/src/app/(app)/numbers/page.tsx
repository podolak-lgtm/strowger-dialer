import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { PLAN_DEFAULTS, isIdlePoolNumber } from "@strowger/shared/did-plan";
import { redirect } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, PageHeader, inputClass } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { IdleRelease } from "./idle-release";
import { assignCampaign, releaseOne, syncNow } from "./actions";
import { Flash, param, statusTone } from "./parts";

/**
 * Numbers tab: the inventory (every number, pool or campaign, with release)
 * and the idle-in-the-pool card. Ordering, 10DLC and the carrier setup are
 * their own tabs (owner, 7 Nov); see HANDOFF "Navigation".
 */
export default async function NumbersPage({ searchParams }: PageProps<"/numbers">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  // Old links: /numbers?campaign=… (campaign page) and the order search (?areaCode=&qty=) belong to the Order tab now.
  if (param(sp, "campaign") || param(sp, "areaCode") || param(sp, "qty")) {
    const u = new URLSearchParams();
    for (const k of ["campaign", "areaCode", "qty", "msg", "kind"]) if (param(sp, k)) u.set(k, param(sp, k));
    redirect(`/numbers/order?${u.toString()}`);
  }

  const now = new Date();
  const idleCutoff = new Date(now.getTime() - PLAN_DEFAULTS.idleDays * 86_400_000);
  const [campaigns, numbers, idleRows, platformRates, account] = await Promise.all([
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id, status: { not: "RETIRED" } }, orderBy: [{ createdAt: "desc" }], include: { campaign: { select: { name: true } } }, take: 300 }),
    prisma.callerIdNumber.findMany({
      where: { tenantId: s.tenant.id, campaignId: null, status: { not: "RETIRED" }, provisionStatus: { not: "released" }, OR: [{ lastUsedAt: { lt: idleCutoff } }, { lastUsedAt: null, createdAt: { lt: idleCutoff } }] },
      orderBy: [{ lastUsedAt: "asc" }, { createdAt: "asc" }],
      take: 500,
    }),
    prisma.platformRates.findUnique({ where: { id: "default" } }),
    prisma.billingAccount.findUnique({ where: { tenantId: s.tenant.id }, select: { didMarkupPct: true } }),
  ]);
  // What one number costs this workspace a month: our cost plus the markup (the platform workspace pays cost).
  const didCost = platformRates?.didMonthlyCents ?? 110;
  const priceCents = s.tenant.isPlatform ? didCost : Math.round(didCost * (1 + (account?.didMarkupPct ?? 50) / 100));
  const idle = idleRows
    .filter((n) => isIdlePoolNumber(n, now))
    .map((n) => ({ id: n.id, phone: n.phone, status: n.status, lastUsed: n.lastUsedAt ? n.lastUsedAt.toISOString().slice(0, 10) : "never used", idleDays: Math.floor((now.getTime() - (n.lastUsedAt ?? n.createdAt).getTime()) / 86_400_000), releasable: Boolean(n.telnyxNumberId) }));
  const inPool = numbers.filter((n) => !n.campaignId).length;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const th = "text-xs font-medium uppercase tracking-wide text-zinc-500";
  const wide = "@min-[760px]:grid-cols-[150px_minmax(190px,1fr)_120px_96px_84px_84px_72px]";

  return (
    <div>
      <PageHeader
        title="Numbers"
        subtitle="Every number on the workspace: pool or campaign, provisioning state, release. Reputation, warm-up and daily caps are on the Reputation tab."
        actions={
          <form action={syncNow}>
            <Button type="submit" variant="ghost">
              Sync with Telnyx
            </Button>
          </form>
        }
      />
      <Flash sp={sp} />

      {idle.length ? (
        <details className="group mb-4 rounded-lg border border-amber-900/60 bg-zinc-900 p-4">
          <summary className="cursor-pointer list-none text-sm">
            <span className="font-semibold text-amber-300">
              {idle.length} idle in the pool {PLAN_DEFAULTS.idleDays}+ days
            </span>
            <span className="text-zinc-400"> · {money(idle.length * priceCents)} a month · </span>
            <span className="text-sky-300 underline group-open:hidden">review and release</span>
            <span className="hidden text-sky-300 underline group-open:inline">hide</span>
          </summary>
          <p className="mb-3 mt-3 text-sm text-zinc-400">
            Pool numbers (not pinned to any campaign) that have not dialled in {PLAN_DEFAULTS.idleDays} days or more. Each costs {money(priceCents)} a month. Keep them for the next campaign, or release the ones you do not need back to Telnyx. Nothing is released automatically.
          </p>
          <IdleRelease numbers={idle} priceCents={priceCents} />
        </details>
      ) : null}

      <Card title={`Numbers (${numbers.length}: ${inPool} in the pool, ${numbers.length - inPool} on campaigns)`}>
        {numbers.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No numbers yet.{" "}
            <NavLink href="/numbers/order" className="text-sky-300 underline">
              Order some
            </NavLink>
            , or Sync to adopt numbers already on the Telnyx account.
          </p>
        ) : (
          <div className="@container">
            <div className={`hidden gap-3 px-1 pb-1.5 @min-[760px]:grid ${wide} ${th}`}>
              <span>Number</span>
              <span>Pool / campaign</span>
              <span>Provisioning</span>
              <span>Telnyx</span>
              <span>jambonz</span>
              <span>Added</span>
              <span />
            </div>
            <div className="space-y-2 @min-[760px]:space-y-0 @min-[760px]:divide-y @min-[760px]:divide-zinc-800">
              {numbers.map((n) => (
                <div key={n.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-md border border-zinc-800 p-2.5 text-sm @min-[760px]:rounded-none @min-[760px]:border-0 @min-[760px]:px-1 @min-[760px]:py-2 ${wide}`}>
                  <div className="col-start-1 row-start-1 min-w-0">
                    <span className="font-mono">{formatPhone(n.phone)}</span>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <Badge tone={n.campaignId ? "blue" : "zinc"}>{n.campaignId ? (n.campaign?.name ?? "campaign") : "pool"}</Badge>
                      {n.status !== "ACTIVE" ? <Badge tone={n.status === "SPAM_FLAGGED" ? "red" : "amber"}>{n.status.toLowerCase().replace("_", " ")}</Badge> : null}
                    </div>
                  </div>
                  <form action={assignCampaign} className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 @min-[760px]:col-span-1 @min-[760px]:col-start-2 @min-[760px]:row-start-1">
                    <input type="hidden" name="id" value={n.id} />
                    <select name="campaignId" aria-label={`Pool or campaign for ${formatPhone(n.phone)}`} defaultValue={n.campaignId ?? ""} className={`${inputClass} min-w-0 py-1 text-xs`}>
                      <option value="">Shared pool</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                      Save
                    </Button>
                  </form>
                  <div className="col-span-2 row-start-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400 @min-[760px]:contents">
                    <div className="@min-[760px]:col-start-3 @min-[760px]:row-start-1">
                      <Badge tone={statusTone(n.provisionStatus)}>{n.provisionStatus}</Badge>
                      {n.provisionError ? <div className="mt-1 text-xs text-red-300">{n.provisionError}</div> : null}
                    </div>
                    <span className="@min-[760px]:col-start-4 @min-[760px]:row-start-1">{n.telnyxNumberId ? (n.smsEnabled ? "voice + SMS" : "voice") : <span className="@max-[759px]:hidden">–</span>}</span>
                    <span className="@min-[760px]:col-start-5 @min-[760px]:row-start-1">{n.jambonzPhoneNumberSid ? <>jambonz <span className="@min-[760px]:hidden">✓</span></> : <span className="@max-[759px]:hidden">–</span>}</span>
                    <span className="@min-[760px]:col-start-6 @min-[760px]:row-start-1">
                      <span className="@min-[760px]:hidden">added </span>
                      {n.createdAt.toLocaleDateString()}
                    </span>
                  </div>
                  <div className="col-start-2 row-start-1 text-right @min-[760px]:col-start-7">
                    {n.telnyxNumberId ? (
                      <form action={releaseOne}>
                        <input type="hidden" name="id" value={n.id} />
                        <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                          Release
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
