// Refer & earn (owner, 6 Nov): a client's link, what to send, the program in
// three lines, and the clients they brought in. Credits are account credit
// only, never cash. Rules: docs/HANDOFF.md "Referral program and free trial".
import Link from "next/link";
import { REFERRAL_TERMS_VERSION } from "@strowger/shared/referrals";
import { requireClientWorkspace } from "@/lib/auth";
import { acceptReferralTerms, myReferrals } from "@/lib/referral-actions";
import { dollars, ensureReferralCode, referralLink, trialOffer } from "@/lib/referrals";
import { money } from "@/components/billing-badge";
import { CopyButton } from "@/components/copy-button";
import { Badge, Button, Card, Notice, PageHeader, Table, Td } from "@/components/ui";

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "zinc" | "blue" | "red" }> = {
  trial: { label: "trial", tone: "blue" },
  active: { label: "active", tone: "green" },
  inactive: { label: "inactive this month", tone: "amber" },
  ended: { label: "ended", tone: "zinc" },
};

export default async function ReferPage({ searchParams }: PageProps<"/refer">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const code = await ensureReferralCode(s.tenant.id);
  const accepted = Boolean(s.tenant.referralTermsAcceptedAt) && s.tenant.referralTermsVersion === REFERRAL_TERMS_VERSION;
  const trial = await trialOffer();

  if (!accepted) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Refer & earn" subtitle="Send a business to Strowger and earn account credit on what they spend, for as long as you are both clients." />
        {sp.error ? <Notice kind="error">Tick the box to accept the terms first.</Notice> : null}
        {s.tenant.referralTermsAcceptedAt ? <Notice kind="warn">The Referral Program Terms have changed since you accepted them. Read and accept the new version to keep your link working.</Notice> : null}
        <Card title="Before you start">
          <ul className="space-y-2 text-sm text-zinc-300">
            <li>· You earn {trial.pct}% of what a business you refer pays for its usage, every month, as credit on your Strowger bill. A $1,000 bill earns you $50.</li>
            <li>· Only while you are both active clients. A month where either of you is not active earns nothing, and the month is not paid later.</li>
            <li>· Credit only: never cash, not transferable, gone if your workspace closes. Only businesses you refer directly count.</li>
            <li>· Do not promote your link with unsolicited calls or texts. Spam or fake accounts forfeit credits.</li>
          </ul>
          <form action={acceptReferralTerms} className="mt-5 space-y-3">
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="accept" required className="mt-1" />
              <span>
                I have read and accept the{" "}
                <Link href="/legal/referral-terms" target="_blank" className="underline">
                  Referral Program Terms
                </Link>{" "}
                (version {REFERRAL_TERMS_VERSION}) for {s.tenant.name}.
              </span>
            </label>
            <Button type="submit">Accept and show my link</Button>
          </form>
        </Card>
      </div>
    );
  }

  const link = referralLink(code);
  const data = await myReferrals();
  const blurbEmail = `Subject: A dialer worth trying\n\nWe run our calling on Strowger, an outbound dialer with the compliance rules built in (calling hours, do-not-call, local caller ID). You can try it free for ${trial.days} days with ${trial.seats} agent seats and ${dollars(trial.allowanceCents)} of calling included, no card needed:\n\n${link}\n\nOne trial per business.`;
  const blurbSms = `We use Strowger for our dialer. Free ${trial.days}-day trial, ${trial.seats} seats, no card: ${link}`;

  return (
    <div>
      <PageHeader title="Refer & earn" subtitle={`${s.tenant.name} earns ${data.pct}% of a referred client's paid usage each month, as account credit.`} />
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Your link">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100">{link}</code>
            <CopyButton text={link} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">It opens a short page about Strowger with a free {trial.days}-day trial. Whoever starts the trial within 30 days of clicking it is yours.</p>
          <div className="mt-5 space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
                <span>Email</span>
                <CopyButton text={blurbEmail} label="Copy email" />
              </div>
              <pre className="whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">{blurbEmail}</pre>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
                <span>Text message (send only to people who asked for it)</span>
                <CopyButton text={blurbSms} label="Copy text" />
              </div>
              <pre className="whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">{blurbSms}</pre>
            </div>
          </div>
        </Card>
        <Card title="How it works">
          <ol className="space-y-2 text-sm text-zinc-300">
            <li>1. Share your link. They get a free {trial.days}-day trial with {trial.seats} seats.</li>
            <li>2. Each month they pay for usage, you get {data.pct}% of it as credit on your bill: $1,000 billed earns you $50.</li>
            <li>3. It lasts for life, as long as you are both active clients. Credits are never paid out as cash.</li>
          </ol>
          <div className="mt-5 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Active</div>
              <div className="text-xl font-semibold tabular-nums">{data.totals.active}</div>
            </div>
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">This month (est.)</div>
              <div className="text-xl font-semibold tabular-nums">{money(data.totals.monthEstimateCents)}</div>
            </div>
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="text-xs text-zinc-500">Lifetime credits</div>
              <div className="text-xl font-semibold tabular-nums">{money(data.totals.lifetimeCents)}</div>
            </div>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            <Link href="/legal/referral-terms" className="underline">
              Referral Program Terms
            </Link>{" "}
            ·{" "}
            <Link href="/legal/trial-terms" className="underline">
              Trial Terms
            </Link>{" "}
            · <Link href="/billing" className="underline">Credits on your bill</Link>
          </p>
        </Card>
      </div>

      <Card title="Clients you referred" className="mt-6">
        <Table head={["Business", "Joined", "Status", `This month (${data.period}, est.)`, "Lifetime credits"]}>
          {data.rows.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">{r.name}</Td>
              <Td className="text-xs text-zinc-400">{r.joinedAt.slice(0, 10)}</Td>
              <Td>
                <Badge tone={STATUS[r.status]?.tone ?? "zinc"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                {r.status === "ended" && r.endedReason ? <div className="mt-1 text-xs text-zinc-500">{r.endedReason}</div> : null}
                {r.status === "inactive" && r.monthReason ? <div className="mt-1 text-xs text-zinc-500">{r.monthReason}</div> : null}
              </Td>
              <Td className="tabular-nums">
                {money(r.monthEstimateCents)}
                {r.monthBaseCents > 0 ? <div className="text-xs text-zinc-500">on {money(r.monthBaseCents)} so far</div> : null}
              </Td>
              <Td className="tabular-nums">{money(r.lifetimeCents)}</Td>
            </tr>
          ))}
          {data.rows.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">Nobody yet. Share your link above.</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
              <Td>{""}</Td>
            </tr>
          ) : null}
        </Table>
        <p className="mt-2 text-xs text-zinc-500">This month&rsquo;s figure is an estimate from usage so far; the credit is worked out and added to your balance on the 1st of next month. It needs you both active for the month: you with a payment or a balance and at least one agent seat, them with paid usage outside their trial.</p>
      </Card>

      {data.history.length ? (
        <Card title="Monthly statements" className="mt-6">
          <Table head={["Month", "Client", "Base", "Rate", "Credit", "Note"]}>
            {data.history.map((h) => (
              <tr key={h.id}>
                <Td className="text-xs">{h.period}</Td>
                <Td>{h.name}</Td>
                <Td className="tabular-nums">{money(h.baseCents)}</Td>
                <Td className="tabular-nums text-xs">{h.pct}%</Td>
                <Td className={`tabular-nums ${h.creditCents > 0 ? "text-emerald-300" : "text-zinc-500"}`}>
                  {money(h.creditCents)}
                  {h.clawbackCents ? <div className="text-xs text-red-300">clawback {money(-h.clawbackCents)}</div> : null}
                </Td>
                <Td className="text-xs text-zinc-400">{h.status === "FORFEITED" ? `Forfeited: ${h.reason ?? ""}` : "Credited to your balance"}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
