// Clerk: no billing API, so the dashboard with the saved login: the billing page's upcoming figure (shown beside
// ours) and the past invoices (Stripe PDFs), which are read and replace the fixed Clerk cost for their month.
//
// UNTESTED LIVE: written without a Clerk dashboard login. Clerk's dashboard sits behind bot protection that may
// show a CAPTCHA to a headless browser; the run then stops as "needs a person" (upload the invoice instead).
// URLs and selectors are in CLERK_PORTAL; a failing step leaves a screenshot on /platform → Balances.
import { amountNear, signIn, stripeInvoicePdfs, withPortal, type PortalSelectors } from "./browser";
import type { Connector, FoundInvoice } from "./types";
import { periodOf } from "./types";

export const CLERK_PORTAL = {
  sel: {
    signInUrl: "https://dashboard.clerk.com/sign-in",
    identifier: 'input[name="identifier"]',
    continueAfterIdentifier: 'button.cl-formButtonPrimary, button:has-text("Continue")',
    password: 'input[name="password"]',
    submit: 'button.cl-formButtonPrimary, button:has-text("Continue")',
    signedIn: 'a[href*="/apps/app_"], a[href*="/apps/new"]',
    // Clerk shows one six-box code field for both; the heading tells them apart.
    totpInput: '.cl-signIn-totp2Fa input, input[name="totp"]',
    emailCodeInput: '.cl-signIn-emailCode input, input[name="code"]',
    emailFrom: /clerk/i,
    error: ".cl-formFieldErrorText, .cl-alert",
  } satisfies PortalSelectors,
  /** Billing lives in the workspace (organisation) settings. */
  billingUrls: ["https://dashboard.clerk.com/settings/billing", "https://dashboard.clerk.com/billing"],
  billingLink: 'a:has-text("Billing"), a[href*="billing"]',
  amountLabel: /(upcoming invoice|next invoice|amount due|current period|estimated total)/i,
};

export const clerk: Connector = {
  vendor: "clerk",
  label: "Clerk",
  method: "browser",
  collects: "From the dashboard's billing page, the upcoming figure and the past invoice PDFs (read, replacing the fixed Clerk cost)",
  whereToGet: "The Clerk dashboard email and password (dashboard.clerk.com). For two-factor sign-in save the authenticator secret, or have Clerk email the code to an address at our domain.",
  credentials: [
    { key: "username", label: "Dashboard email", secret: false },
    { key: "password", label: "Dashboard password", secret: true },
    { key: "totpSecret", label: "Authenticator secret (optional)", secret: true, optional: true },
    { key: "emailCodeTo", label: "Email code goes to (optional, @ our domain)", secret: false, optional: true },
  ],
  missing: (c) => (c.username && c.password ? null : "Enter the Clerk dashboard email and password"),
  async collect(ctx) {
    const invoices: FoundInvoice[] = [];
    let reported: { period: string; cents: number } | null = null;
    await withPortal("clerk", ctx, async (p) => {
      await p.step("signing in", "Signing in to the Clerk dashboard", () => signIn(p.page, CLERK_PORTAL.sel, ctx, "Clerk"));
      await p.step("downloading", "Opening billing", async () => {
        let found = false;
        for (const url of CLERK_PORTAL.billingUrls) {
          await p.page.goto(url, { waitUntil: "domcontentloaded" });
          await p.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
          if (/billing/i.test(await p.page.title()) || (await p.page.locator("text=/invoice/i").count())) {
            found = true;
            break;
          }
        }
        if (!found && (await p.page.locator(CLERK_PORTAL.billingLink).count())) await p.page.locator(CLERK_PORTAL.billingLink).first().click();
        const cents = await amountNear(p.page, CLERK_PORTAL.amountLabel);
        if (cents !== null) reported = { period: periodOf(ctx.now), cents };
        for (const bytes of await stripeInvoicePdfs(p.page)) invoices.push({ file: { bytes, type: "pdf" } });
        if (!invoices.length && reported === null) throw new Error("Found neither invoices nor an upcoming figure on the billing page");
      });
    });
    return { reported, invoices };
  },
};
