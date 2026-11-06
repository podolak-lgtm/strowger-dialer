// Card payments, provider-agnostic (owner, 6 Nov: "it ends with putting in a
// credit card; I'm trying to get a merchant account today").
//
// Strowger never sees or stores a card number. A provider plugs in behind
// `PaymentProvider` and collects the card on its own hosted page or hosted
// fields (Stripe Checkout / Payment Element, or the merchant account's
// equivalent); Strowger keeps only the provider's customer / payment ids.
// Money reaches the ledger in one place: a verified webhook event →
// `recordPayment` with the provider's payment id as the idempotency key.
//
// Until a provider is configured (`PAYMENT_PROVIDER` unset or "none") the
// NONE provider answers every call with "not set up": the wizard then shows
// the wire/ACH instructions and the platform admin is emailed to send a
// payment link. docs/HANDOFF.md "Client onboarding wizard" lists exactly what
// a real provider needs.
import { config } from "../config";
import { log } from "../log";
import { recordPayment } from "../billing";

export type ProviderId = "none" | "stripe";

export interface SetupIntentInput {
  tenantId: string;
  /** Who pays: the client's contact email (for the provider's receipt). */
  email: string;
  amountCents: number;
  /** Where the hosted page sends the client back (the wizard's Payment step). */
  returnUrl: string;
}

/** What the browser does next. `none`: show the manual instructions. `redirect`: go to the provider's hosted checkout. `embedded`: mount the provider's hosted fields with this client secret. */
export type SetupIntentResult = { mode: "none"; message: string } | { mode: "redirect"; url: string; reference: string } | { mode: "embedded"; clientSecret: string; publishableKey: string; reference: string };

export interface ChargeResult {
  ok: boolean;
  status: "succeeded" | "pending" | "failed";
  providerRef?: string;
  error?: string;
}

/** A verified provider event, already mapped to what Strowger does with it. */
export type PaymentEvent = { kind: "payment_succeeded"; tenantId: string; amountCents: number; providerRef: string; note: string } | { kind: "card_saved"; tenantId: string; providerRef: string; brand?: string; last4?: string } | { kind: "ignored"; reason: string };

export interface PaymentProvider {
  id: ProviderId;
  configured: boolean;
  label: string;
  /** Start collecting a card (and, with an amount, the first prepayment) on the provider's hosted page or fields. */
  createSetupIntent(input: SetupIntentInput): Promise<SetupIntentResult>;
  /** After the client comes back: ask the provider what happened to `reference`. Never trusted for money: only the webhook credits. */
  confirm(input: { tenantId: string; reference: string }): Promise<{ ok: boolean; status: string }>;
  /** Charge the saved card (top-ups later). */
  charge(input: { tenantId: string; amountCents: number; idempotencyKey: string }): Promise<ChargeResult>;
  /** Verify the signature on a raw webhook body and map it to events. Throws on a bad signature. */
  webhook(input: { rawBody: string; headers: Record<string, string | undefined> }): Promise<PaymentEvent[]>;
}

const NOT_SET_UP = "Card payments are being set up. We'll email you a secure payment link; you can also pay by wire or ACH.";

export const noneProvider: PaymentProvider = {
  id: "none",
  configured: false,
  label: "No card processor yet",
  async createSetupIntent() {
    return { mode: "none", message: NOT_SET_UP };
  },
  async confirm() {
    return { ok: false, status: "not_configured" };
  },
  async charge() {
    return { ok: false, status: "failed", error: NOT_SET_UP };
  },
  async webhook() {
    throw new Error("No payment provider is configured (PAYMENT_PROVIDER)");
  },
};

// TODO(provider): add the processor here, e.g. `stripeProvider` in ./stripe.ts:
//   createSetupIntent → Checkout Session (mode "payment", amount, customer_email,
//     client_reference_id = tenantId, metadata.tenantId, success/cancel = returnUrl,
//     payment_intent_data.setup_future_usage = "off_session") → { mode: "redirect", url }
//   confirm → retrieve the session; status only (money is credited by the webhook)
//   charge → PaymentIntent off_session on the saved payment method, idempotencyKey
//   webhook → stripe.webhooks.constructEvent(rawBody, headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
//     checkout.session.completed (payment_status "paid") and payment_intent.succeeded
//     → payment_succeeded { tenantId: metadata.tenantId, amountCents: amount_received, providerRef: payment_intent id }
//     setup_intent.succeeded → card_saved; everything else → ignored
// and return it from paymentProvider() when PAYMENT_PROVIDER = "stripe" and its keys are set.
export function paymentProvider(): PaymentProvider {
  const id = (config.PAYMENT_PROVIDER || "none") as ProviderId;
  if (id !== "none") log.warn({ id }, "payments: PAYMENT_PROVIDER names a provider that is not built yet; using none");
  return noneProvider;
}

/** Apply verified events: money goes through `recordPayment` once per provider payment id. */
export async function applyPaymentEvents(events: PaymentEvent[], providerId: ProviderId): Promise<{ credited: number; ignored: number }> {
  let credited = 0;
  let ignored = 0;
  for (const e of events) {
    if (e.kind === "payment_succeeded") {
      const done = await recordPayment(e.tenantId, e.amountCents, e.note, null, { uniqueKey: `pay:${providerId}:${e.providerRef}` });
      if (done) credited++;
      else ignored++;
    } else ignored++;
  }
  return { credited, ignored };
}
