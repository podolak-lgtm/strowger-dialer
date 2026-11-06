// The free trial on every page for the people who can act on it: days and
// allowance left, louder from day 5 (the reminder; there is no email path
// yet), and the "Your trial ended" line once the engine has suspended it.
import Link from "next/link";
import { TRIAL_REMINDER_DAY, inTrial, trialDay, trialDaysLeft } from "@strowger/shared/referrals";
import type { BillingStatus } from "@/lib/billing-actions";
import { money } from "@/components/billing-badge";

type TrialTenant = { trialStartedAt: Date | null; trialEndsAt: Date | null; trialConvertedAt: Date | null };

export function TrialBanner({ tenant, billing, now }: { tenant: TrialTenant; billing: BillingStatus | null; now: Date }) {
  if (!tenant.trialEndsAt) return null;
  const ends = tenant.trialEndsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (billing?.suspendReason === "TRIAL_ENDED" && billing.suspended) {
    return (
      <div className="border-b-2 border-red-500 bg-red-950 px-6 py-3 text-sm text-red-100">
        <b>Your trial ended: add a prepayment to keep dialing.</b> Everything you set up is kept: campaigns, lists, leads and numbers.{" "}
        <Link href="/billing" className="underline">
          How to prepay
        </Link>
      </div>
    );
  }
  if (!inTrial(tenant, now)) return null;
  const left = trialDaysLeft(tenant, now);
  const loud = trialDay(tenant, now) >= TRIAL_REMINDER_DAY;
  const allowance = billing ? ` · ${money(Math.max(0, billing.balanceCents))} of usage left` : "";
  return (
    <div className={`border-b px-6 py-2.5 text-sm ${loud ? "border-amber-500 bg-amber-950 text-amber-100" : "border-sky-800 bg-sky-950/70 text-sky-100"}`}>
      <b>Free trial: {left} day{left === 1 ? "" : "s"} left</b> (ends {ends}){allowance}.{" "}
      {loud ? <>When it ends, dialing pauses until a prepayment is recorded. </> : null}
      <Link href="/billing" className="underline">
        Add a prepayment
      </Link>{" "}
      · <Link href="/legal/trial-terms" className="underline">Trial Terms</Link>
    </div>
  );
}
