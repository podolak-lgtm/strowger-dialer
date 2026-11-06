// Client onboarding wizard, the engine's side (docs/HANDOFF.md "Client
// onboarding wizard"). The web app autosaves the answers straight into
// `Tenant.onboarding`; the engine does what touches Telnyx, the ledger or
// email: the website check, the 10DLC submission and its status, reserving
// the first campaign's numbers (now, or when the first payment lands), the
// payment step, and the emails to the client and the platform admin.
import { patchOnboarding, prisma } from "@strowger/db";
import { readOnboarding, type OnboardingState } from "@strowger/shared/onboarding";
import { blocking, toBrandInput, toCampaignInput, validateBrand, validateCampaign, websiteProblems } from "@strowger/shared/tendlc";
import { log } from "../log";
import { emailWorkspace } from "../email";
import { onPayment, rates } from "../billing";
import { createBrand, createTenDlcCampaign, tenDlcStatus } from "../provision";
import { telnyxConfigured, type BrandInput, type CampaignInput } from "../provision/telnyx";
import { applyDidPlan, type ApplyResult } from "../provision/plan";
import { paymentProvider } from "../payments";
import { checkWebsite } from "./website";

export { checkWebsite };

async function state(tenantId: string): Promise<{ s: OnboardingState; t: { id: string; name: string; tenDlcBrandId: string | null; tenDlcCampaignId: string | null } }> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true, onboarding: true, tenDlcBrandId: true, tenDlcCampaignId: true } });
  return { s: readOnboarding(t.onboarding), t };
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Check the website and keep what was found on the wizard state (the Business step reads it). */
export async function checkAndKeepWebsite(tenantId: string, website: string, names: string[]) {
  const f = await checkWebsite(website, names);
  await patchOnboarding(tenantId, [{ set: ["website"], value: f }]);
  return f;
}

// ─────────────────────────────── 10DLC ───────────────────────────────

/** "Submit for registration": the brand (unless one exists) and the campaign, through the provisioning code the Numbers page uses. */
export async function submitRegistration(tenantId: string, userId: string) {
  const { s, t } = await state(tenantId);
  const b = s.steps.business ?? {};
  const c = s.steps.texting ?? {};
  const you = s.steps.you ?? {};
  const brandName = b.dba || b.legalName || t.name;
  const problems = [...blocking(validateBrand(b)), ...blocking(websiteProblems(s.website)), ...blocking(validateCampaign(c, brandName))];
  if (!s.website) problems.push({ field: "website", level: "error", message: "The website has not been checked yet.", fix: "Run the website check on the Business step." });
  if (problems.length) throw new Error(`Not ready to submit: ${problems.map((p) => p.message).join(" ")}`);
  if (!telnyxConfigured) throw new Error("Texting registration is not connected on this server yet (no Telnyx key). Your answers are saved; our team will submit them for you.");

  const now = new Date().toISOString();
  if (!t.tenDlcBrandId) {
    const input = toBrandInput(b, String(you.email ?? b.supportEmail ?? ""));
    await createBrand(tenantId, input as BrandInput);
    await patchOnboarding(tenantId, [{ merge: ["registration"], value: { brandSubmittedAt: now, submittedById: userId } }]);
  }
  await prisma.auditLog.create({ data: { tenantId, actorId: userId, action: "onboarding.tendlc.submit", after: { brand: brandName, usecase: c.usecase ?? null, brandExisted: Boolean(t.tenDlcBrandId) } } });
  if (t.tenDlcCampaignId) return registrationStatus(tenantId);
  await submitCampaign(tenantId, toCampaignInput(c) as Omit<CampaignInput, "brandId">);
  return registrationStatus(tenantId);
}

/** The campaign goes in once the brand is accepted; until then it waits (`campaignPending`) and the job retries. */
async function submitCampaign(tenantId: string, input: Omit<CampaignInput, "brandId">): Promise<boolean> {
  try {
    await createTenDlcCampaign(tenantId, input);
    await patchOnboarding(tenantId, [{ merge: ["registration"], value: { campaignSubmittedAt: new Date().toISOString(), campaignPending: false, error: null } }]);
    return true;
  } catch (e) {
    const error = errMsg(e).slice(0, 400);
    log.info({ tenantId, error }, "onboarding: 10DLC campaign not accepted yet; will retry");
    await patchOnboarding(tenantId, [{ merge: ["registration"], value: { campaignPending: true, error } }]);
    return false;
  }
}

export interface RegistrationView {
  submitted: boolean;
  brand: { id: string | null; status: string | null; identityStatus: string | null; failureReasons: string | null };
  campaign: { id: string | null; status: string | null; failureReasons: string | null };
  campaignPending: boolean;
  error: string | null;
}

/** What the wizard polls: the Telnyx status the Numbers page already reads, and a retry of a waiting campaign. */
export async function registrationStatus(tenantId: string): Promise<RegistrationView> {
  const st = await tenDlcStatus(tenantId);
  let { s } = await state(tenantId);
  const brand = (st.brand ?? {}) as Record<string, unknown>;
  if (s.registration?.campaignPending && st.brandId && !st.campaignId && telnyxConfigured && /VERIFIED|SELF_DECLARED/.test(String(brand.identityStatus ?? "")) && !/UNVERIFIED/.test(String(brand.identityStatus ?? ""))) {
    if (await submitCampaign(tenantId, toCampaignInput(s.steps.texting ?? {}) as Omit<CampaignInput, "brandId">)) return registrationStatus(tenantId);
    ({ s } = await state(tenantId));
  }
  const camp = (st.campaign ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  return {
    submitted: Boolean(st.brandId),
    brand: { id: st.brandId, status: str(brand.status), identityStatus: str(brand.identityStatus), failureReasons: str(brand.failureReasons) },
    campaign: { id: st.campaignId, status: str(camp.campaignStatus ?? camp.status), failureReasons: str(camp.failureReasons) },
    campaignPending: Boolean(s.registration?.campaignPending),
    error: s.registration?.error ?? null,
  };
}

/** Job: campaigns waiting for their brand, retried every 30 minutes for two weeks. */
export async function retryPendingCampaigns(): Promise<void> {
  if (!telnyxConfigured) return;
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Tenant" WHERE ("onboarding" -> 'registration' ->> 'campaignPending') = 'true' AND "tenDlcBrandId" IS NOT NULL AND "tenDlcCampaignId" IS NULL AND "updatedAt" > now() - interval '14 days' LIMIT 50`;
  for (const r of rows) await registrationStatus(r.id).catch((e) => log.warn({ err: e, tenantId: r.id }, "onboarding: 10DLC retry failed"));
}

// ─────────────────────────────── Numbers for the first campaign ───────────────────────────────

const summarise = (r: ApplyResult) => {
  const ordered = r.ordered.reduce((n, o) => n + o.phones.length, 0);
  return `${r.taken.length} from the pool, ${ordered} ordered${r.short.length ? `; short: ${r.short.map((x) => `${x.areaCode} ×${x.count} (${x.reason})`).join(", ")}` : ""}`;
};

/**
 * "Reserve these numbers". Pool numbers are pinned at once (free). What has to
 * be bought is bought now when the workspace may spend; otherwise the plan is
 * saved and ordered by itself when the first payment lands (`onPayment`).
 */
export async function reserveNumbers(input: { tenantId: string; userId: string; requestedBy?: string; poolFirst: boolean; exactOnly: boolean }) {
  const { s } = await state(input.tenantId);
  const fc = s.firstCampaign;
  if (!fc) throw new Error("Load your leads file first: the plan comes from its area codes.");
  const result = await applyDidPlan({ tenantId: input.tenantId, campaignId: fc.campaignId, userId: input.userId, requestedBy: input.requestedBy, poolFirst: input.poolFirst, exactOnly: input.exactOnly });
  const waiting = result.short.some((x) => x.reason === "billing");
  const now = new Date().toISOString();
  await patchOnboarding(input.tenantId, [{ set: ["reserve"], value: { state: waiting ? "pending_funds" : result.error ? "failed" : "applied", savedAt: now, appliedAt: waiting ? undefined : now, poolFirst: input.poolFirst, exactOnly: input.exactOnly, summary: summarise(result), userId: input.userId } }]);
  await prisma.auditLog.create({ data: { tenantId: input.tenantId, actorId: input.userId, action: waiting ? "onboarding.numbers.saved" : "onboarding.numbers.reserved", target: fc.campaignId, after: { summary: summarise(result) } } });
  return { result, savedForPayment: waiting };
}

/** First payment: order the numbers the wizard saved. */
async function orderSavedNumbers(tenantId: string): Promise<void> {
  const { s } = await state(tenantId);
  const r = s.reserve;
  if (r?.state !== "pending_funds" || !s.firstCampaign) return;
  // Claim it first so two payments in a row do not order twice.
  const claimed = await prisma.$executeRaw`UPDATE "Tenant" SET "onboarding" = jsonb_set("onboarding", '{reserve,state}', '"ordering"'::jsonb) WHERE "id" = ${tenantId} AND ("onboarding" -> 'reserve' ->> 'state') = 'pending_funds'`;
  if (!claimed) return;
  try {
    const result = await applyDidPlan({ tenantId, campaignId: s.firstCampaign.campaignId, userId: r.userId ?? "system", poolFirst: r.poolFirst, exactOnly: r.exactOnly, requestedBy: "onboarding: first payment" });
    const stillWaiting = result.short.some((x) => x.reason === "billing");
    await patchOnboarding(tenantId, [{ merge: ["reserve"], value: { state: stillWaiting ? "pending_funds" : result.error ? "failed" : "applied", appliedAt: new Date().toISOString(), summary: summarise(result) } }]);
    await prisma.auditLog.create({ data: { tenantId, action: "onboarding.numbers.ordered_on_payment", target: s.firstCampaign.campaignId, after: { summary: summarise(result) } } });
    if (!stillWaiting) {
      const ordered = result.ordered.reduce((n, o) => n + o.phones.length, 0);
      void emailWorkspace(
        tenantId,
        {
          subject: "Your Strowger numbers are on their way",
          title: "Your payment landed and your numbers are ordered",
          paragraphs: [`We took ${result.taken.length} number${result.taken.length === 1 ? "" : "s"} from the pool and ordered ${ordered} new local number${ordered === 1 ? "" : "s"} for your first campaign, as planned in your setup.`, ...(result.short.length ? [`Not everything was available: ${result.short.map((x) => `${x.areaCode}: ${x.reason}`).join("; ")}.`] : []), "New numbers finish setting up within a few minutes."],
          button: { label: "See your numbers", path: "/numbers" },
        },
        `onboarding-numbers:${tenantId}:${r.savedAt}`,
      );
    }
  } catch (e) {
    log.warn({ err: e, tenantId }, "onboarding: ordering saved numbers failed");
    await patchOnboarding(tenantId, [{ merge: ["reserve"], value: { state: "failed", summary: errMsg(e).slice(0, 300) } }]);
  }
}
onPayment((tenantId) => orderSavedNumbers(tenantId));

// ─────────────────────────────── Payment step ───────────────────────────────

/** Platform admins (the owner's workspace). */
async function platformTenantId(): Promise<string | null> {
  return (await prisma.tenant.findFirst({ where: { isPlatform: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))?.id ?? null;
}

/**
 * The client chose an amount and pressed the button. With a card processor:
 * its hosted page. Without one: the wire/ACH instructions, and the platform
 * admin is emailed (and it is audit-logged) to send a payment link.
 */
export async function startPayment(input: { tenantId: string; userId: string; amountCents: number; email: string; returnUrl: string }) {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 100) throw new Error("Choose an amount of at least $1.");
  const provider = paymentProvider();
  const r = await rates();
  const now = new Date().toISOString();
  await patchOnboarding(input.tenantId, [{ set: ["paymentRequest"], value: { amountCents: input.amountCents, requestedAt: now, provider: provider.id } }]);
  await prisma.auditLog.create({ data: { tenantId: input.tenantId, actorId: input.userId, action: "onboarding.payment.requested", after: { amountCents: input.amountCents, provider: provider.id } } });
  if (provider.configured) {
    const setup = await provider.createSetupIntent({ tenantId: input.tenantId, email: input.email, amountCents: input.amountCents, returnUrl: input.returnUrl });
    return { setup, instructions: r.prepayInstructions };
  }
  await notifyPlatform(input.tenantId, input.amountCents, input.email);
  return { setup: await provider.createSetupIntent({ tenantId: input.tenantId, email: input.email, amountCents: input.amountCents, returnUrl: input.returnUrl }), instructions: r.prepayInstructions };
}

async function notifyPlatform(tenantId: string, amountCents: number, email: string): Promise<void> {
  const pid = await platformTenantId();
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const amount = `$${(amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  if (pid) {
    await prisma.auditLog.create({ data: { tenantId: pid, action: "onboarding.payment_link_needed", target: tenantId, after: { client: t.name, amountCents, email } } });
    void emailWorkspace(
      pid,
      {
        subject: `${t.name} finished onboarding and needs a payment link (${amount})`,
        title: `${t.name} needs a payment link`,
        paragraphs: [`${t.name} reached the Payment step of onboarding and chose a first prepayment of ${amount}.`, `Card payments are not connected yet, so send a secure payment link to ${email}, or wire/ACH instructions, and record the payment on Platform → Clients when it lands.`, "If they reserved numbers without funds, they are ordered automatically when that payment is recorded."],
        button: { label: "Open Platform → Clients", path: "/platform?tab=clients" },
      },
      `onboarding-paylink:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
      2 * 86_400,
    );
  }
}

// ─────────────────────────────── Welcome email ───────────────────────────────

/** The owner created a workspace for a client with their email: a sign-in link that lands on /welcome. */
export async function welcomeEmail(tenantId: string, adminEmail: string): Promise<boolean> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  return emailWorkspace(
    tenantId,
    {
      subject: `Your Strowger workspace for ${t.name} is ready`,
      title: `Welcome to Strowger, ${t.name}`,
      paragraphs: [
        `Your contact center workspace is ready. Sign in with ${adminEmail} (create your password the first time) and a short setup walks you through your business details, texting registration, your leads file, your team and your first prepayment.`,
        "You can skip around and come back any time: only your name and email are required.",
        "Most clients are fully live in about 7 days: texting registration (10DLC) usually takes about 3 business days; numbers and dialing are ready the same day once you add funds.",
      ],
      button: { label: "Start your setup", path: "/sign-up?redirect_url=%2Fwelcome" },
    },
    `welcome:${tenantId}`,
  );
}
