import { prisma } from "@strowger/db";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createWorkspace, moveCampaignToWorkspace, openWorkspace, platformOverview, recordPayment, savePlan, saveRates, syncVendorCosts, vendorSpend } from "@/lib/billing-actions";
import { money } from "@/components/billing-badge";
import { Badge, Button, Card, Field, Notice, PageHeader, Table, Td, inputClass } from "@/components/ui";

// The owner's view (platform workspace only): every client's balance, this
// month's revenue, cost and margin; record prepayments; set each client's
// rate plan; what we pay, pulled from the vendors; create client
// workspaces, step into one, move a campaign into one.

const cents = (c: number) => money(c);
const toMilli = (m: number) => (m / 1000).toFixed(2);
const VENDOR_KIND: Record<string, string> = { "sip-trunking": "Calls", messaging: "Texts", amd: "Answering-machine detection", "conference-participant": "Conference legs", recording: "Recordings", media_storage: "Media storage", "ai.classify": "AI: reading text replies", "ai.assist": "AI: agent assist" };

export default async function PlatformPage({ searchParams }: PageProps<"/platform">) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) redirect("/dashboard");
  const sp = await searchParams;
  const period = typeof sp.period === "string" ? sp.period : undefined;
  const msg = typeof sp.msg === "string" ? sp.msg : null;
  const kind = sp.kind === "error" ? "error" : "ok";
  const [o, v, campaigns] = await Promise.all([platformOverview(period), vendorSpend(period), prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  const totals = o.tenants.reduce((t, x) => ({ revenue: t.revenue + x.revenueCents, cost: t.cost + x.costCents, balance: t.balance + x.balanceCents }), { revenue: 0, cost: 0, balance: 0 });
  const platformTenantId = s.actingFrom?.id ?? s.tenant.id;

  return (
    <div>
      <PageHeader title="Platform billing" subtitle={`Every client, ${o.period}. Prices to clients are per workspace; costs come from the vendors' records where they can be matched, else from the rates below.`} />
      {msg ? <Notice kind={kind}>{msg}</Notice> : null}
      <div className="mb-6 grid gap-4 md:grid-cols-5">
        {[
          ["Revenue this month", cents(totals.revenue)],
          ["Cost this month (attributed)", cents(totals.cost)],
          ["Margin", cents(totals.revenue - totals.cost)],
          ["Prepaid held", cents(totals.balance)],
          ["Telnyx balance", v.telnyxBalanceCents === null ? "—" : cents(v.telnyxBalanceCents)],
        ].map(([l, val]) => (
          <div key={l} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{l}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{val}</div>
          </div>
        ))}
      </div>

      <Card title="Clients">
        <Table head={["Client", "Seats", "Balance", "Revenue", "Cost", "Margin", "Record payment", ""]}>
          {o.tenants.map((t) => (
            <tr key={t.id}>
              <Td>
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-zinc-500">
                  {t.users} people{t.suspended ? " · " : ""}
                  {t.suspended ? <Badge tone="red">outbound paused</Badge> : null}
                </div>
              </Td>
              <Td className="tabular-nums">{t.seats}</Td>
              <Td className={`tabular-nums ${t.balanceCents <= 0 ? "text-red-300" : t.balanceCents <= t.lowBalanceCents ? "text-amber-300" : ""}`}>{cents(t.balanceCents)}</Td>
              <Td className="tabular-nums">{cents(t.revenueCents)}</Td>
              <Td className="tabular-nums text-zinc-400">{cents(t.costCents)}</Td>
              <Td className={`tabular-nums ${t.marginCents < 0 ? "text-red-300" : "text-emerald-300"}`}>{cents(t.marginCents)}</Td>
              <Td>
                <form action={recordPayment} className="flex items-center gap-1">
                  <input type="hidden" name="tenantId" value={t.id} />
                  <input name="amount" placeholder="$ amount" className={`${inputClass} w-24 py-1 text-xs`} required />
                  <input name="note" placeholder="wire, check #…" className={`${inputClass} w-32 py-1 text-xs`} />
                  <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                    Apply
                  </Button>
                </form>
              </Td>
              <Td>
                <form action={openWorkspace}>
                  <input type="hidden" name="tenantId" value={t.id} />
                  <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                    Open
                  </Button>
                </form>
              </Td>
            </tr>
          ))}
          {o.tenants.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">No client workspaces yet. Create one below.</Td>
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Td key={i}>{""}</Td>
              ))}
            </tr>
          ) : null}
        </Table>
        <p className="mt-2 text-xs text-zinc-500">A negative amount is an adjustment (credit back or correction). Payments lift a pause immediately. &ldquo;Open&rdquo; steps you into that client&rsquo;s workspace as its admin until you come back.</p>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="New client workspace">
          <form action={createWorkspace} className="space-y-3 text-sm">
            <Field label="Business name">
              <input name="name" className={inputClass} placeholder="National Solar Resolutions" required />
            </Field>
            <Field label="Their admin's email (optional)" hint="They sign in with it and land in their own workspace as admin. Leave blank to run it yourself from here.">
              <input name="adminEmail" type="email" className={inputClass} />
            </Field>
            <Button type="submit">Create workspace</Button>
            <p className="text-xs text-zinc-500">A new workspace starts empty with a billing account on the default plan and a zero balance. Open it to set up people, numbers and campaigns, or move a campaign into it below.</p>
          </form>
        </Card>

        <Card title={`Move a campaign out of ${s.tenant.name}`}>
          {campaigns.length === 0 ? (
            <p className="text-sm text-zinc-500">No campaigns in this workspace to move.</p>
          ) : (
            <form action={moveCampaignToWorkspace} className="space-y-3 text-sm">
              <Field label="Campaign">
                <select name="campaignId" className={inputClass}>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To workspace">
                <select name="toTenantId" className={inputClass}>
                  {o.tenants
                    .filter((t) => t.id !== s.tenant.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  {s.actingFrom ? <option value={platformTenantId}>{s.actingFrom.name} (platform)</option> : null}
                </select>
              </Field>
              <Button type="submit" variant="danger">
                Move campaign
              </Button>
              <p className="text-xs text-zinc-500">Takes the campaign with its lists, leads and history, calls, texts, callbacks, dispositions, dial plans, scripts, webhooks, the numbers pinned to it, and the agents who work only this campaign. Cadence profiles and audio it uses are copied; the system do-not-call list is copied. One transaction: all or nothing.</p>
            </form>
          )}
        </Card>
      </div>

      <Card title={`What the vendors charged us, ${v.period}`} className="mt-6">
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
          <span>
            Total <b className="tabular-nums">{cents(v.totalCents)}</b>
          </span>
          <span className="text-zinc-400">
            not matched to a client: <b className="tabular-nums">{cents(v.unattributedCents)}</b>
          </span>
          <span className="text-xs text-zinc-500">
            Telnyx records pulled {v.telnyxSyncedAt ? new Date(v.telnyxSyncedAt).toLocaleString() : "never"} (hourly, last 2 days each time)
          </span>
          <form action={syncVendorCosts}>
            <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
              Pull the last 7 days now
            </Button>
          </form>
        </div>
        <Table head={["Vendor", "What", "Records", "Quantity", "Cost"]}>
          {v.rows.map((r) => (
            <tr key={`${r.vendor}:${r.kind}`}>
              <Td className="capitalize">{r.vendor}</Td>
              <Td>{VENDOR_KIND[r.kind] ?? r.kind}</Td>
              <Td className="tabular-nums">{r.records.toLocaleString()}</Td>
              <Td className="tabular-nums text-zinc-400">{r.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })}</Td>
              <Td className="tabular-nums">{cents(r.costCents)}</Td>
            </tr>
          ))}
          {v.rows.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">Nothing pulled yet. Calls and texts appear here after the first hourly sync with records to match.</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
            </tr>
          ) : null}
        </Table>
        <p className="mt-2 text-xs text-zinc-500">Calls are matched to our records by direction, number and start time; texts by the message id; AI requests are costed from their token counts at list price. The litigator scrub has no price API, so it uses the rate below.</p>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="Fallback cost rates (used until a vendor record is matched)">
          <form action={saveRates} className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Telnyx outbound, ¢ per minute">
                <input name="outPerMin" defaultValue={toMilli(o.rates.telnyxOutMillicentsPerMin)} className={inputClass} />
              </Field>
              <Field label="Telnyx inbound, ¢ per minute">
                <input name="inPerMin" defaultValue={toMilli(o.rates.telnyxInMillicentsPerMin)} className={inputClass} />
              </Field>
              <Field label="Number, $ per month">
                <input name="didMonthly" defaultValue={(o.rates.didMonthlyCents / 100).toFixed(2)} className={inputClass} />
              </Field>
              <Field label="Scrub, ¢ per record">
                <input name="scrubCost" defaultValue={toMilli(o.rates.scrubCostMillicents)} className={inputClass} />
              </Field>
              <Field label="Text, ¢ per segment">
                <input name="smsCost" defaultValue={toMilli(o.rates.smsCostMillicents)} className={inputClass} />
              </Field>
            </div>
            <Field label="Prepayment instructions shown to clients" hint="Bank wire details, who to email the remittance to, and so on.">
              <textarea name="prepayInstructions" rows={4} defaultValue={o.rates.prepayInstructions ?? ""} className={inputClass} />
            </Field>
            <Button type="submit" variant="ghost">
              Save cost rates
            </Button>
            <p className="text-xs text-zinc-500">Telnyx list prices (Nov 2026): outbound US from 0.5¢/min, inbound from 0.32¢/min, local number $1.00/month plus $0.10 with texting.</p>
          </form>
        </Card>

        <Card title="Rate plan per client">
          <div className="space-y-4">
            {o.tenants.map((t) => {
              const p = t.plan ?? { seatMonthlyCents: 7000, perMinuteMillicents: 1200, didMarkupPct: 50, scrubMarginMillicents: 500, smsPriceMillicents: 1500, lowBalanceCents: 20000, graceDays: 3 };
              return (
                <form key={t.id} action={savePlan} className="rounded-md border border-zinc-800 p-3 text-sm">
                  <input type="hidden" name="tenantId" value={t.id} />
                  <div className="mb-2 font-medium">{t.name}</div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Field label="Seat $/mo">
                      <input name="seat" defaultValue={(p.seatMonthlyCents / 100).toFixed(2)} className={inputClass} />
                    </Field>
                    <Field label="¢ / minute">
                      <input name="perMinute" defaultValue={toMilli(p.perMinuteMillicents)} className={inputClass} />
                    </Field>
                    <Field label="Number markup %">
                      <input name="didMarkup" defaultValue={p.didMarkupPct} className={inputClass} />
                    </Field>
                    <Field label="Scrub margin ¢/rec">
                      <input name="scrubMargin" defaultValue={toMilli(p.scrubMarginMillicents)} className={inputClass} />
                    </Field>
                    <Field label="Text ¢/segment">
                      <input name="smsPrice" defaultValue={toMilli(p.smsPriceMillicents)} className={inputClass} />
                    </Field>
                    <Field label="Warn below $">
                      <input name="lowBalance" defaultValue={(p.lowBalanceCents / 100).toFixed(2)} className={inputClass} />
                    </Field>
                    <Field label="Grace days at $0">
                      <input name="graceDays" defaultValue={p.graceDays} className={inputClass} />
                    </Field>
                  </div>
                  <Button type="submit" variant="ghost" className="mt-2">
                    Save plan
                  </Button>
                </form>
              );
            })}
            {o.tenants.length === 0 ? <p className="text-sm text-zinc-500">Plans appear per client once there are client workspaces. Defaults: $70 per seat, 1.2¢ per minute, numbers at cost + 50%, scrub at cost + 0.5¢ per record, warn below $200, 3 days of grace at zero.</p> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
