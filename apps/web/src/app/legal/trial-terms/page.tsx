// ─────────────────────────────────────────────────────────────────────────
// LAWYER REVIEW REQUIRED BEFORE LAUNCH. These terms were drafted from the
// owner's instructions of 6 Nov 2026 and have not been reviewed by counsel.
// The owner's lawyer must review them, and fill in [STATE], before the free
// trial is offered. Keep them in step with packages/shared/src/referrals.ts,
// the engine's trial limits (apps/engine/src/billing, referrals) and
// docs/HANDOFF.md "Referral program and free trial"; bump
// TRIAL_TERMS_VERSION on any change in substance.
// ─────────────────────────────────────────────────────────────────────────
import type { Metadata } from "next";
import Link from "next/link";
import { TRIAL_TERMS_VERSION } from "@strowger/shared/referrals";
import { dollars, trialOffer } from "@/lib/referrals";
import { Clause, LegalPage } from "../legal-ui";

export const metadata: Metadata = { title: "Trial Terms · Strowger" };
export const dynamic = "force-dynamic";

export default async function TrialTerms() {
  const t = await trialOffer();
  return (
    <LegalPage title="Free Trial Terms" version={TRIAL_TERMS_VERSION}>
      <p>
        These terms govern a free trial of Strowger (the &ldquo;Trial&rdquo;). &ldquo;We&rdquo; and &ldquo;Strowger&rdquo; mean the operator of the Strowger platform; &ldquo;you&rdquo;
        means the business that creates the workspace. By starting the Trial you accept these terms and the platform usage terms in clause 9.
      </p>

      <Clause n={1} title="What the Trial includes">
        The Trial lasts {t.days} days from the moment your workspace is created. It includes up to {t.seats} agent seats at no charge and a usage allowance of {dollars(t.allowanceCents)}{" "}
        that covers usage charged at your plan&rsquo;s rates (talk time, phone numbers, scrub records). Outbound calling is available while the allowance lasts; when it is used up,
        dialing pauses until you add a prepayment. There is no card and nothing to cancel.
      </Clause>

      <Clause n={2} title="Limits during the Trial">
        <ol className="list-[lower-alpha] space-y-1.5 pl-5">
          <li>At most {t.seats} different agents may log in to the dialer.</li>
          <li>At most {t.maxNumbers} phone numbers may be held by the workspace.</li>
          <li>
            Texting is off. Texts sent from a trial would go out under the platform&rsquo;s own business texting (10DLC) registration, so texting opens only once you are a paying client
            with your own registration in place.
          </li>
          <li>Administrators and supervisors are free and do not count as seats, as on every plan.</li>
        </ol>
      </Clause>

      <Clause n={3} title="The allowance is not money">
        The allowance is a usage credit, not a payment. It cannot be withdrawn, refunded, transferred or exchanged for cash, it does not count toward any referral commission, and any
        part of it not used by the end of the Trial is removed from your account then.
      </Clause>

      <Clause n={4} title="One trial per business">
        Each business may have one Trial. We refuse a Trial when the email domain of the person signing up (or, for free email services such as Gmail, Yahoo, Outlook, iCloud, AOL or
        Hotmail, the full email address) or the business phone number already belongs to a Strowger workspace or an earlier Trial. Creating extra accounts to get further trials is a
        breach of these terms; we may close those workspaces.
      </Clause>

      <Clause n={5} title="Becoming a client">
        Recording your first prepayment ends the Trial limits on seats, numbers and texting. Seats are then charged at your plan&rsquo;s rate from the next agent login, and all usage is
        charged against your prepaid balance under your Strowger agreement.
      </Clause>

      <Clause n={6} title="When the Trial ends without a payment">
        On day 5 the app reminds you that the Trial is ending. If no prepayment has been recorded when it ends, the workspace is suspended: agents cannot log in to dial, numbers
        cannot be ordered and nothing is dialed. Adding a prepayment lifts the suspension.
      </Clause>

      <Clause n={7} title="Your data">
        Suspension does not delete anything. Your campaigns, lists, leads, call history and settings are kept, and your phone numbers stay on the account while it is in good
        standing, so you can pick up where you left off after a prepayment. Call recordings follow your workspace&rsquo;s recording retention setting, as on every plan. You may ask us
        to export or delete your data at any time.
      </Clause>

      <Clause n={8} title="Ending or changing the Trial">
        We may change the Trial offer for new sign-ups at any time. We may end a Trial early for a breach of these terms, for abuse, or to protect the platform, its carriers or
        called parties.
      </Clause>

      <Clause n={9} id="usage" title="Platform usage terms: consent and compliance are yours">
        <ol className="list-[lower-alpha] space-y-1.5 pl-5">
          <li>
            You are solely responsible for having the legally required consent for every person you call or text through Strowger, and for keeping evidence of it. Strowger&rsquo;s tools
            (calling windows, attempt limits, do-not-call checks, scrubs) help you comply but do not make you compliant.
          </li>
          <li>
            You must comply with the Telephone Consumer Protection Act and FCC rules, the Telemarketing Sales Rule, the National Do Not Call Registry, state telemarketing and mini-TCPA
            laws (for example Florida, Oklahoma, Maryland and Washington), caller ID rules, and carrier and texting registration requirements.
          </li>
          <li>You may not use Strowger for unlawful, deceptive or harassing calls or texts, or to call numbers on any do-not-call list you are bound by.</li>
          <li>
            You will indemnify us against claims, fines and costs arising from calls or texts made through your workspace, except to the extent caused by our own breach.
          </li>
          <li>We may suspend a workspace immediately when we reasonably believe it is being used in breach of this clause or when a carrier requires it.</li>
        </ol>
      </Clause>

      <Clause n={10} title="Liability">
        The Trial is provided as is and free of charge. To the extent the law allows, we have no liability arising from the Trial beyond restoring the unused allowance where we
        removed it in error.
      </Clause>

      <Clause n={11} title="Governing law">
        These terms are governed by the laws of the State of [STATE], without regard to its conflict-of-laws rules, and any dispute about them is subject to the courts of [STATE].
      </Clause>

      <p className="text-zinc-500">
        Referred by a client? Their side of the program is in the <Link href="/legal/referral-terms" className="underline">Referral Program Terms</Link>.
      </p>
    </LegalPage>
  );
}
