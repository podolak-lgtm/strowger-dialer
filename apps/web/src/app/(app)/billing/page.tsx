import { requireClientWorkspace } from "@/lib/auth";
import { billingOverview } from "@/lib/billing-actions";
import { money } from "@/components/billing-badge";
import Link from "next/link";
import { Badge, Card, Notice, PageHeader, Table, Td } from "@/components/ui";

const CATEGORY_LABEL: Record<string, string> = { SEAT: "Seats", MINUTES: "Minutes", DID: "Phone numbers", SCRUB: "Scrub records", SMS: "Texts", OTHER: "Other", PAYMENT: "Payments", TRIAL: "Free trial", REFERRAL: "Referral program", AI: "AI answer" };
const KIND_LABEL: Record<string, string> = { TRIAL_CREDIT: "trial allowance", REFERRAL_CREDIT: "referral credit", REFERRAL_CLAWBACK: "referral clawback" };
const KIND_TONE: Record<string, "green" | "amber" | "zinc" | "blue" | "red"> = { PAYMENT: "green", ADJUSTMENT: "amber", TRIAL_CREDIT: "blue", REFERRAL_CREDIT: "green", REFERRAL_CLAWBACK: "red" };
const cents = (c: number) => money(c);
const rate = (millicents: number) => `${(millicents / 1000).toFixed(millicents % 1000 === 0 ? 0 : 2)}¢`;

export default async function BillingPage({ searchParams }: PageProps<"/billing">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const period = typeof sp.period === "string" ? sp.period : undefined;
  const o = await billingOverview(period);
  const b = o.status;
  const mtd = o.categories.reduce((n, c) => n + c.amountCents, 0);

  return (
    <div>
      <PageHeader title="Billing" subtitle={`${s.tenant.name} · prepaid. Seats are charged on an agent's first login each month; minutes, numbers, scrub records and texts as they happen.`} />
      {b.suspended && b.suspendReason === "TRIAL_ENDED" ? (
        <Notice kind="error">Your trial ended: add a prepayment to keep dialing. Everything you set up is kept; dialing resumes the moment the payment is recorded.</Notice>
      ) : b.trial?.active ? (
        <Notice kind="warn">
          Free trial until {new Date(b.trial.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}: {b.trial.seats} seats at no charge and a {cents(b.trial.allowanceCents)} usage allowance (not money: it cannot be withdrawn and any unused part is removed when the trial ends). Up to {b.trial.maxNumbers} numbers, no texting. A prepayment ends the trial limits; without one, dialing pauses when the trial ends.{" "}
          <Link href="/legal/trial-terms" className="underline">
            Trial Terms
          </Link>
        </Notice>
      ) : b.suspended ? (
        <Notice kind="error">Outbound calling is paused: the balance has been at or below zero for more than {b.graceDays} days. Add a payment and it resumes automatically.</Notice>
      ) : b.critical ? (
        <Notice kind="error">The balance is used up. Outbound keeps running for {b.graceDays} day{b.graceDays === 1 ? "" : "s"} of grace, then pauses until a payment lands.</Notice>
      ) : b.low ? (
        <Notice kind="warn">
          Low balance. At the current rate of use there are about {b.runwayDays ?? "?"} days left. Top up before it reaches zero: outbound pauses {b.graceDays} days after that.
        </Notice>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Balance</div>
          <div className={`mt-1 text-3xl font-semibold tabular-nums ${b.critical ? "text-red-300" : b.low ? "text-amber-300" : ""}`}>{cents(b.balanceCents)}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Spend this month ({o.period})</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{cents(mtd)}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Daily average (30 days)</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{cents(b.dailyAvgCents)}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Runway</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{b.runwayDays === null ? "—" : `${b.runwayDays} d`}</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="Your rates">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-800">
              <tr>
                <td className="py-2 text-zinc-400">Seat (an agent who logs in during the month)</td>
                <td className="py-2 text-right tabular-nums">{cents(b.rates.seatMonthlyCents)} / month</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-400">Talk time, inbound and outbound, by the second</td>
                <td className="py-2 text-right tabular-nums">{rate(b.rates.perMinuteMillicents)} / minute</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-400">Phone numbers</td>
                <td className="py-2 text-right tabular-nums">carrier cost + {b.rates.didMarkupPct}% / month</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-400">Litigator and DNC scrub</td>
                <td className="py-2 text-right tabular-nums">cost + {rate(b.rates.scrubMarginMillicents)} / record</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-400">Text messages</td>
                <td className="py-2 text-right tabular-nums">{rate(b.rates.smsPriceMillicents)} / segment</td>
              </tr>
              {b.rates.aiMinutePriceMillicents ? (
                <tr>
                  <td className="py-2 text-zinc-400">AI answer on inbound queues, by the second (on top of talk time)</td>
                  <td className="py-2 text-right tabular-nums">{rate(b.rates.aiMinutePriceMillicents)} / minute</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-500">Supervisors and admins are free: only agents who log in to the dialer count as seats.</p>
        </Card>

        <Card title="How to prepay">
          {o.prepayInstructions ? <p className="whitespace-pre-wrap text-sm text-zinc-300">{o.prepayInstructions}</p> : <p className="text-sm text-zinc-500">Payment instructions have not been set yet. Contact your account manager.</p>}
          <p className="mt-3 text-xs text-zinc-500">Payments are applied by hand within a business day; the balance here updates the moment they are.</p>
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-3 text-sm">
        <span>
          Referral credits this month: <b className={`tabular-nums ${o.referralCreditsCents > 0 ? "text-emerald-300" : ""}`}>{cents(o.referralCreditsCents)}</b>
        </span>
        <span className="text-xs text-zinc-500">
          Account credit for clients you referred, posted on the 1st for the month before. Credit only, never cash.{" "}
          <Link href="/refer" className="underline">
            Refer &amp; earn
          </Link>
        </span>
      </div>

      <Card title={`This month by category (${o.period})`} className="mt-6">
        <Table head={["Category", "Quantity", "Amount"]}>
          {o.categories.map((c) => (
            <tr key={c.category}>
              <Td>{CATEGORY_LABEL[c.category] ?? c.category}</Td>
              <Td className="tabular-nums">{c.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })}</Td>
              <Td className="tabular-nums">{cents(c.amountCents)}</Td>
            </tr>
          ))}
          {o.categories.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">Nothing charged yet this month.</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
            </tr>
          ) : null}
        </Table>
        {o.statements.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {o.statements.map((st) => (
              <a key={st.period} href={`/billing?period=${st.period}`} className={`rounded border px-2 py-1 ${st.period === o.period ? "border-zinc-500 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                {st.period} · {cents(st.amountCents)}
              </a>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="Ledger" className="mt-6">
        <Table head={["When", "Type", "Category", "Detail", "Qty", "Amount"]}>
          {o.entries.map((e) => (
            <tr key={e.id}>
              <Td className="text-xs text-zinc-400">{new Date(e.at).toLocaleString()}</Td>
              <Td>
                <Badge tone={KIND_TONE[e.kind] ?? "zinc"}>{KIND_LABEL[e.kind] ?? e.kind.toLowerCase()}</Badge>
              </Td>
              <Td className="text-xs">{CATEGORY_LABEL[e.category] ?? e.category}</Td>
              <Td className="text-xs text-zinc-300">{e.note ?? ""}</Td>
              <Td className="tabular-nums text-xs">{e.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</Td>
              <Td className={`tabular-nums ${e.amountCents >= 0 ? "text-emerald-300" : ""}`}>{cents(e.amountCents)}</Td>
            </tr>
          ))}
          {o.entries.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">No activity yet.</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
            </tr>
          ) : null}
        </Table>
      </Card>
    </div>
  );
}
