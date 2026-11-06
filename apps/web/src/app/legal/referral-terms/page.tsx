// ─────────────────────────────────────────────────────────────────────────
// LAWYER REVIEW REQUIRED BEFORE LAUNCH. These terms were drafted from the
// owner's instructions of 6 Nov 2026 and have not been reviewed by counsel.
// The owner's lawyer must review them, and fill in [STATE], before the
// referral program is offered to clients. Keep them in step with the rules
// in packages/shared/src/referrals.ts and docs/HANDOFF.md "Referral program
// and free trial"; bump REFERRAL_TERMS_VERSION there on any change in
// substance so every client accepts the new version.
// ─────────────────────────────────────────────────────────────────────────
import type { Metadata } from "next";
import Link from "next/link";
import { REFERRAL_INACTIVE_DAYS_TEXT, LegalPage, Clause } from "../legal-ui";
import { REFERRAL_COOKIE_DAYS, REFERRAL_TERMS_VERSION } from "@strowger/shared/referrals";
import { trialOffer } from "@/lib/referrals";

export const metadata: Metadata = { title: "Referral Program Terms · Strowger" };
export const dynamic = "force-dynamic";

export default async function ReferralTerms() {
  const t = await trialOffer();
  return (
    <LegalPage title="Referral Program Terms" version={REFERRAL_TERMS_VERSION}>
      <p>
        These terms govern the Strowger referral program (the &ldquo;Program&rdquo;). &ldquo;We&rdquo;, &ldquo;us&rdquo; and &ldquo;Strowger&rdquo; mean the operator of the Strowger platform.
        &ldquo;You&rdquo; or the &ldquo;Referrer&rdquo; means the client business whose workspace accepts these terms. A &ldquo;Referred Client&rdquo; is a business that signs up through your
        referral link. They add to, and do not replace, the agreement under which you use Strowger.
      </p>

      <Clause n={1} title="Eligibility">
        You may take part while your business has an active, paying Strowger workspace in good standing and an administrator or supervisor of it has accepted these terms. The
        platform operator&rsquo;s own workspace does not take part. We may refuse or remove participation for a breach of these terms or of your Strowger agreement.
      </Clause>

      <Clause n={2} title="Your link">
        Your workspace has one referral link. A business is credited to you only if it opens your link, starts its free trial within {REFERRAL_COOKIE_DAYS} days in the same browser,
        and is new to Strowger (it has never had a workspace or a trial). If a business opens more than one referral link, the first valid link it opened counts. Until the Referred
        Client makes its first payment, we may correct who referred it where the record is wrong; after that payment the attribution is final.
      </Clause>

      <Clause n={3} title="Single tier">
        You earn only on businesses you refer directly. You earn nothing on businesses that your Referred Clients refer in turn.
      </Clause>

      <Clause n={4} title="How the credit is calculated">
        <ol className="list-[lower-alpha] space-y-1.5 pl-5">
          <li>
            The rate is {t.pct}% unless we have agreed a different rate with you in writing (shown on your Refer &amp; earn page).
          </li>
          <li>
            Each calendar month (UTC) we take the Referred Client&rsquo;s charges for usage in that month: seats, minutes, phone numbers, scrub records, texts and any other usage
            charge. We exclude anything used during its free trial and anything covered by the trial allowance.
          </li>
          <li>
            The base is the part of those charges covered by real money: the lower of (i) those charges and (ii) the payments the Referred Client made that month, less any refunds that
            month, plus the positive balance it carried into the month from its own payments. Trial allowance and referral credit are never counted as money.
          </li>
          <li>The credit is the rate times the base, rounded to the cent.</li>
          <li>
            Example: a Referred Client is billed $1,000 for usage in a month and has paid for it. At 5% you receive a $50 credit. If it paid for only $600 of that $1,000, the base is
            $600 and the credit is $30.
          </li>
          <li>
            The credit for a month is worked out on the first day of the next month and added to your account then. Your Refer &amp; earn page shows an estimate during the month; the
            amount posted on the 1st is the one that counts.
          </li>
        </ol>
      </Clause>

      <Clause n={5} title="Both of you must be active that month">
        A month earns a credit only if, for that month: (a) your workspace was not suspended at the end of the month, made at least one payment or had a positive balance, and was
        charged for at least one agent seat; and (b) the Referred Client had paid usage, was not in its free trial at the end of the month, and was not suspended at the end of the
        month. If either condition fails, that month&rsquo;s credit is forfeited. A forfeited month is shown on your page with the reason and a zero amount; it is not saved up or paid
        in a later month.
      </Clause>

      <Clause n={6} title="When a referral ends">
        A referral ends permanently, and earns nothing from then on, if: (a) your workspace has had no payment and no usage for {REFERRAL_INACTIVE_DAYS_TEXT} consecutive days; (b)
        your workspace is closed; (c) we end it under clause 10 or 11; or (d) we end the Program. Credits already added to your account before the end stay there, subject to clause 8.
        If a Referred Client stops using Strowger, nothing is earned for the months it is not active, but the referral stays open.
      </Clause>

      <Clause n={7} title="Credits only, never cash">
        <ol className="list-[lower-alpha] space-y-1.5 pl-5">
          <li>Every credit is a credit on your Strowger account that reduces what you owe for future usage. We never pay referral credits in cash, by check, by transfer or in any other form.</li>
          <li>Credits have no cash value, cannot be sold, transferred, assigned or moved to another workspace, and cannot be redeemed for cash, even when your credit balance is more than your usage.</li>
          <li>A credit balance above what you use simply carries forward to cover future usage. If it is never used, it is not paid out.</li>
          <li>Credits expire, with no payment of any kind, when your workspace is closed for any reason.</li>
        </ol>
      </Clause>

      <Clause n={8} title="Refunds and chargebacks">
        If we refund a Referred Client, or a payment it made is reversed or charged back, and that money had counted toward a credit you received, we take the matching credit back
        from your account at the same rate (a &ldquo;clawback&rdquo;). A clawback can reduce your balance below zero, in which case it is treated like any other charge on your account.
      </Clause>

      <Clause n={9} title="No self-referral, no fake accounts">
        You may not refer your own business, a business under common ownership or control, or a business that shares your email domain, and you may not create or arrange
        accounts, trials, payments or usage in order to earn credits. One trial per business applies to Referred Clients. If we reasonably believe this clause has been broken, we
        may withhold or reverse the credits involved, end the referrals, remove you from the Program, and take action on the accounts concerned under your Strowger agreement.
      </Clause>

      <Clause n={10} title="No spam">
        You must promote your link lawfully. You may not send it by unsolicited calls, prerecorded or artificial-voice messages, or texts or emails to people who have not agreed to
        receive them, and you must comply with the Telephone Consumer Protection Act, the Telemarketing Sales Rule, CAN-SPAM, state telemarketing and mini-TCPA laws, and do-not-call
        rules when you do. You are responsible for every message you send about the Program. A breach of this clause lets us end your referrals and forfeit unposted credits, and you
        will indemnify us against claims arising from your messages.
      </Clause>

      <Clause n={11} title="Changes and ending the Program">
        We may change the rate or these terms for the future by giving you at least 30 days&rsquo; notice in the app or by email. Changes never reduce a credit for a month that has
        already ended. We may end the Program on 30 days&rsquo; notice; credits already on your account when it ends stay there and can be used for usage as set out in clause 7. When
        the terms change in substance you will be asked to accept the new version before your link keeps working.
      </Clause>

      <Clause n={12} title="Taxes">
        You are responsible for any taxes that apply to credits you receive. We do not give tax advice.
      </Clause>

      <Clause n={13} title="Our records">
        The amounts posted to your account are worked out from our billing records, which decide any question about charges, payments, refunds and activity. If you think a credit is
        wrong, tell us within 60 days of it being posted.
      </Clause>

      <Clause n={14} title="Liability">
        The Program is provided as is. To the extent the law allows, our total liability arising from the Program is limited to the credits properly due to you and not yet posted.
      </Clause>

      <Clause n={15} title="Governing law">
        These terms are governed by the laws of the State of [STATE], without regard to its conflict-of-laws rules, and any dispute about them is subject to the courts of [STATE].
      </Clause>

      <p className="text-zinc-500">
        See also the <Link href="/legal/trial-terms" className="underline">Trial Terms</Link> that Referred Clients accept.
      </p>
    </LegalPage>
  );
}
