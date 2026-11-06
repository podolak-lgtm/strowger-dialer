// A client's referral link (owner, 6 Nov). Public: what Strowger is, the
// free trial, and "Start free trial", which goes through ./start to set the
// strowger_ref cookie and on to sign-up. Onboarding reads the cookie.
import Link from "next/link";
import { dollars, referrerByCode, trialOffer } from "@/lib/referrals";

export const dynamic = "force-dynamic";

export default async function ReferralLanding({ params }: PageProps<"/r/[code]">) {
  const { code } = await params;
  const [referrer, trial] = await Promise.all([referrerByCode(code), trialOffer()]);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl space-y-6">
        <div className="rounded-sm border-[3px] border-[#1b1b1f] bg-[#f6efe0] p-6 text-[#1b1b1f] shadow-[8px_8px_0_#000]">
          <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#c8472b]">{referrer ? `${referrer.name} invited you` : "Strowger"}</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">An outbound dialer with compliance built in</h1>
          <p className="mt-3 text-base leading-relaxed">
            Strowger is a contact center for human agents: ratio and preview dialing, local caller ID, voicemail drop, inbound routing, transfers, live floor supervision, and the calling-hours and
            do-not-call rules applied on every dial.
          </p>
        </div>

        {referrer ? (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Try it free for {trial.days} days</h2>
            <ul className="mt-3 space-y-1.5 text-sm text-zinc-300">
              <li>· {trial.seats} agent seats, free for the whole trial</li>
              <li>· {dollars(trial.allowanceCents)} of calling usage included (minutes, numbers, scrubs)</li>
              <li>· Up to {trial.maxNumbers} phone numbers; texting opens once you are a paying client</li>
              <li>· No card, nothing to cancel: when the trial ends, dialing pauses until you add a prepayment. Your data stays.</li>
            </ul>
            <a href={`/r/${referrer.code}/start`} className="mt-5 block rounded-md bg-zinc-100 px-4 py-2.5 text-center font-medium text-zinc-900 hover:bg-white">
              Start free trial
            </a>
            <p className="mt-3 text-xs text-zinc-500">
              One trial per business. By starting you agree to the{" "}
              <Link href="/legal/trial-terms" className="underline">
                Trial Terms
              </Link>
              , including that you are responsible for consent and TCPA compliance on every lead you dial.
            </p>
          </section>
        ) : (
          <section className="rounded-lg border border-amber-900 bg-amber-950/40 p-6 text-sm text-amber-100">
            This invitation link is not active. Ask whoever sent it for a new one, or{" "}
            <Link href="/" className="underline">
              read about Strowger
            </Link>
            .
          </section>
        )}
        <p className="text-center text-xs text-zinc-600">
          Already a client? <Link href="/sign-in" className="underline">Sign in</Link> ·{" "}
          <Link href="/legal/referral-terms" className="underline">
            Referral Program Terms
          </Link>
        </p>
      </div>
    </main>
  );
}
