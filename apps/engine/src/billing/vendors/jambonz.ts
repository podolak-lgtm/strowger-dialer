// jambonz.cloud: the API where it answers (plan name and the upcoming invoice, billing/vendor.ts pullJambonz, with
// the engine's JAMBONZ_API_KEY), then the portal with the saved login for what the API does not give: the
// subscription page's figures and the past invoices (Stripe PDFs), which are read and replace the fixed jambonz
// plan cost for their month.
//
// UNTESTED LIVE: written without a jambonz.cloud login. The URLs and selectors below are a best reading of the
// portal and will need adjusting on the first run; a failing step leaves a screenshot on /platform → Balances.
import { config } from "../../config";
import { pullJambonz } from "../vendor";
import { amountNear, signIn, stripeInvoicePdfs, withPortal, type PortalSelectors } from "./browser";
import type { Connector, FoundInvoice } from "./types";
import { periodOf } from "./types";

/** Everything that drifts, in one place. */
export const JAMBONZ_PORTAL = {
  sel: {
    signInUrl: "https://jambonz.cloud/sign-in",
    identifier: 'input[type="email"], input[name="email"]',
    password: 'input[type="password"], input[name="password"]',
    submit: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")',
    signedIn: 'a[href*="/internal/applications"], a[href*="/internal/accounts"]',
    emailCodeInput: 'input[name="code"], input[autocomplete="one-time-code"]',
    emailFrom: /jambonz/i,
    error: '[role="alert"], .msg--error, .error',
  } satisfies PortalSelectors,
  /** The account's subscription and billing page. */
  billingUrls: ["https://jambonz.cloud/internal/account/manage-payment", "https://jambonz.cloud/internal/account/subscription", "https://jambonz.cloud/internal/account"],
  /** Labels the monthly figure sits beside. */
  amountLabel: /(next invoice|upcoming invoice|amount due|monthly total|total per month|subscription)/i,
  /** A link to the payment portal (Stripe) where past invoices live, when they are not on the page itself. */
  invoicesLink: 'a:has-text("Invoices"), a:has-text("Billing history"), button:has-text("Manage payment"), a:has-text("Manage payment")',
};

export const jambonz: Connector = {
  vendor: "jambonz",
  label: "jambonz.cloud",
  method: "api+browser",
  collects: "Plan and upcoming invoice from the API; from the portal, the subscription's monthly figure and the past invoice PDFs (read, replacing the fixed plan cost)",
  whereToGet: "The jambonz.cloud email and password (the portal at jambonz.cloud). If the account has two-factor sign-in, save the authenticator secret (shown as text when you set the app up) or make the account email an address at our domain so the code can be read from Crossbar's inbox.",
  credentials: [
    { key: "username", label: "Portal email", secret: false },
    { key: "password", label: "Portal password", secret: true },
    { key: "totpSecret", label: "Authenticator secret (optional)", secret: true, optional: true },
    { key: "emailCodeTo", label: "Email code goes to (optional, @ our domain)", secret: false, optional: true },
  ],
  missing: (c) => (c.username && c.password ? null : config.JAMBONZ_API_KEY ? null : "Enter the jambonz.cloud portal email and password"),
  async collect(ctx) {
    const { now, creds, step } = ctx;
    let note: string | null = null;
    let reported: { period: string; cents: number } | null = null;
    if (config.JAMBONZ_API_KEY) {
      await step("downloading", "Asking the jambonz API for the plan and upcoming invoice");
      const r = await pullJambonz().catch((e) => ({ plan: null, invoiceCents: null, error: e instanceof Error ? e.message : String(e) }));
      note = r.plan ? `Plan: ${r.plan}` : null;
      if (r.invoiceCents !== null) reported = { period: periodOf(now), cents: r.invoiceCents };
    }
    if (!creds.username || !creds.password) return { note, reported };

    const invoices: FoundInvoice[] = [];
    await withPortal("jambonz", ctx, async (p) => {
      await p.step("signing in", "Signing in to the jambonz.cloud portal", () => signIn(p.page, JAMBONZ_PORTAL.sel, ctx, "jambonz.cloud"));
      await p.step("downloading", "Opening the subscription page", async () => {
        for (const url of JAMBONZ_PORTAL.billingUrls) {
          await p.page.goto(url, { waitUntil: "domcontentloaded" });
          await p.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
          const cents = await amountNear(p.page, JAMBONZ_PORTAL.amountLabel);
          if (cents !== null) {
            reported = { period: periodOf(now), cents };
            break;
          }
        }
        let pdfs = await stripeInvoicePdfs(p.page);
        if (!pdfs.length && (await p.page.locator(JAMBONZ_PORTAL.invoicesLink).count())) {
          // The payment portal opens in the same tab or a new one.
          const popup = p.context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
          await p.page.locator(JAMBONZ_PORTAL.invoicesLink).first().click();
          const target = (await popup) ?? p.page;
          await target.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
          pdfs = await stripeInvoicePdfs(target);
        }
        for (const bytes of pdfs) invoices.push({ file: { bytes, type: "pdf" } });
      });
    });
    return { note, reported, invoices };
  },
};
