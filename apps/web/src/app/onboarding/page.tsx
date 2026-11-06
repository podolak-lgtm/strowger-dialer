import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { REFERRAL_COOKIE } from "@strowger/shared/referrals";
import { getSession } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { createTenant } from "./actions";

type Offer = { referrer: { name: string } | null; selfReferral: boolean; trial: { days: number; seats: number; allowanceCents: number; maxNumbers: number } | null; refusedReason: string | null };

const box = "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2";

export default async function Onboarding({ searchParams }: PageProps<"/onboarding">) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (await getSession()) redirect("/dashboard");
  const clerk = await currentUser();
  const email = clerk?.primaryEmailAddress?.emailAddress ?? "";
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : null;
  const refused = typeof sp.refused === "string" ? sp.refused : null;
  const ref = (await cookies()).get(REFERRAL_COOKIE)?.value ?? "";
  const offer = await engine<Offer>(`/signup/offer?email=${encodeURIComponent(email)}&ref=${encodeURIComponent(ref)}&clerkUserId=${encodeURIComponent(userId)}`).catch((): Offer => ({ referrer: null, selfReferral: false, trial: null, refusedReason: null }));
  const refusedNow = refused ?? offer.refusedReason;
  // A trial is on offer and this business has not been refused one: ask for the trial terms.
  const trial = offer.trial && !refusedNow ? offer.trial : null;

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <form action={createTenant} className="w-full max-w-md space-y-5 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Set up your contact center</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Signed in as {email}. No workspace has invited this address, so create one. You will be its administrator.
          </p>
        </div>
        {offer.referrer ? <p className="rounded-md border border-sky-800 bg-sky-950/40 px-3 py-2 text-sm text-sky-100">Invited by {offer.referrer.name}.</p> : null}
        {offer.selfReferral ? <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">That invitation link belongs to your own business, so it does not count as a referral.</p> : null}
        {trial ? (
          <div className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100">
            <b>Free trial: {trial.days} days, {trial.seats} seats, ${(trial.allowanceCents / 100).toFixed(0)} of usage.</b> Up to {trial.maxNumbers} numbers, no texting during the trial. When it ends, dialing
            pauses until you add a prepayment; your data is kept.
          </div>
        ) : null}
        {refusedNow && offer.trial ? (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
            No free trial: {refusedNow} One trial per business. You can still create a workspace; dialing starts once a prepayment is recorded.
            <input type="hidden" name="withoutTrial" value="1" />
          </div>
        ) : null}
        {error ? <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">{error}</p> : null}
        <label className="block text-sm">
          <span className="text-zinc-300">Company name</span>
          <input name="name" required minLength={2} maxLength={80} className={box} placeholder="Acme Contact Center" />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-300">Business phone</span>
          <input name="businessPhone" required={Boolean(trial)} inputMode="tel" className={box} placeholder="(305) 555-1234" />
          {trial ? <span className="mt-1 block text-xs text-zinc-500">Used to keep it to one trial per business.</span> : null}
        </label>
        {trial ? (
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="acceptTrialTerms" required className="mt-1" />
            <span>
              I accept the{" "}
              <Link href="/legal/trial-terms" target="_blank" className="underline">
                Trial Terms
              </Link>
              .
            </span>
          </label>
        ) : null}
        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input type="checkbox" name="acceptUsageTerms" required className="mt-1" />
          <span>
            I accept the platform&rsquo;s usage terms (
            <Link href="/legal/trial-terms#usage" target="_blank" className="underline">
              read them
            </Link>
            ), including that my business is responsible for having consent and for TCPA and state telemarketing compliance on every lead it calls or texts.
          </span>
        </label>
        <button className="w-full rounded-md bg-zinc-100 px-4 py-2 font-medium text-zinc-900">{trial ? "Start free trial" : "Create workspace"}</button>
      </form>
    </main>
  );
}
