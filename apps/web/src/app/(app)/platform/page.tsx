import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { platformOverview, recordPayment, savePlan, saveRates } from "@/lib/billing-actions";
import { money } from "@/components/billing-badge";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";

// The owner's view (platform workspace only): every client's balance, this
// month's revenue, cost and margin; record prepayments; set each client's
// rate plan; set what we pay the carrier and the scrub.

const cents = (c: number) => money(c);
const toMilli = (m: number) => (m / 1000).toFixed(2);

export default async function PlatformPage({ searchParams }: PageProps<"/platform">) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform) redirect("/dashboard");
  const sp = await searchParams;
  const period = typeof sp.period === "string" ? sp.period : undefined;
  const o = await platformOverview(period);
  const totals = o.tenants.reduce((t, x) => ({ revenue: t.revenue + x.revenueCents, cost: t.cost + x.costCents, balance: t.balance + x.balanceCents }), { revenue: 0, cost: 0, balance: 0 });

  return (
    <div>
      <PageHeader title="Platform billing" subtitle={`Every client, ${o.period}. Prices to clients are per workspace; costs are what we pay (rates below).`} />
      <div className="mb-6 grid gap-4 md:grid-cols-4">
        {[
          ["Revenue this month", cents(totals.revenue)],
          ["Cost this month", cents(totals.cost)],
          ["Margin", cents(totals.revenue - totals.cost)],
          ["Prepaid held", cents(totals.balance)],
        ].map(([l, v]) => (
          <div key={l} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{l}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <Card title="Clients">
        <Table head={["Client", "Seats", "Balance", "Revenue", "Cost", "Margin", "Record payment"]}>
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
            </tr>
          ))}
          {o.tenants.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">No client workspaces yet. Clients appear here as they sign up.</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
            </tr>
          ) : null}
        </Table>
        <p className="mt-2 text-xs text-zinc-500">A negative amount is an adjustment (credit back or correction). Payments lift a pause immediately.</p>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="What we pay (cost rates)">
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
            <p className="text-xs text-zinc-500">Telnyx list prices (Nov 2026): outbound US from 0.5¢/min, inbound from 0.32¢/min, local number $1.00/month plus $0.10 with texting. Check your Telnyx invoice and correct these.</p>
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
