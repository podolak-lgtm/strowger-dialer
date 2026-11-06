// Signing in to a vendor portal with Playwright (Chromium is in the engine image
// for the Free Caller Registry). Each browser connector keeps its URLs and
// selectors in one object (PortalSelectors) because they drift; this file holds
// what every portal needs: sign in, answer a second factor (an authenticator
// code from the saved secret, or an emailed code read from Crossbar's inbox),
// stop with "needs a person" at a CAPTCHA or a factor we cannot answer, and on
// any failure keep a screenshot in the bucket.
//
// None of the portals has been signed in to from a development machine (the
// sessions that wrote this had no vendor logins): the first live run is the test.
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { totp, totpSecondsLeft } from "@strowger/shared/totp";
import { log } from "../../log";
import { waitForEmailCode } from "./inbox";
import { putVendorFile } from "./storage";
import { NeedsPerson, type CollectContext } from "./types";

export interface PortalSelectors {
  signInUrl: string;
  /** Email or username box. */
  identifier: string;
  /** Some portals ask for the email first and show the password after a Continue. */
  continueAfterIdentifier?: string;
  password: string;
  submit: string;
  /** Visible once signed in. */
  signedIn: string;
  /** An authenticator-app code box. */
  totpInput?: string;
  /** An emailed-code box. */
  emailCodeInput?: string;
  /** Submit after a code (default: press Enter). */
  codeSubmit?: string;
  /** Sender or subject of the sign-in email, to pick it out of the inbox. */
  emailFrom?: RegExp;
  /** Anything here on screen means a CAPTCHA or bot check: stop for a person. */
  captcha?: string[];
  /** A visible sign-in error message. */
  error?: string;
}

const DEFAULT_CAPTCHA = ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]', "#challenge-form", '[id*="captcha" i]', 'text="Verify you are human"'];

export interface Portal {
  page: Page;
  context: BrowserContext;
  /** Run a step: its name goes on the live status line, and a failure is reported as that step's. */
  step: <T>(name: string, line: string, fn: () => Promise<T>) => Promise<T>;
}

async function visible(page: Page, selector: string | undefined, timeout = 0): Promise<boolean> {
  if (!selector) return false;
  try {
    if (timeout) await page.locator(selector).first().waitFor({ state: "visible", timeout });
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

async function checkCaptcha(page: Page, sel: PortalSelectors): Promise<void> {
  for (const c of [...DEFAULT_CAPTCHA, ...(sel.captcha ?? [])]) if (await visible(page, c)) throw new NeedsPerson(`A CAPTCHA or bot check appeared on ${new URL(page.url()).host}; sign in once by hand from a normal browser, then try again`);
}

/** Sign in, answering a second factor when we can. */
export async function signIn(page: Page, sel: PortalSelectors, ctx: CollectContext, label: string): Promise<void> {
  const { creds } = ctx;
  await page.goto(sel.signInUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  if (await visible(page, sel.signedIn)) return; // a remembered session
  await checkCaptcha(page, sel);
  await page.locator(sel.identifier).first().fill(creds.username ?? "");
  if (sel.continueAfterIdentifier && !(await visible(page, sel.password))) {
    await page.locator(sel.continueAfterIdentifier).first().click();
    await page.locator(sel.password).first().waitFor({ state: "visible", timeout: 20_000 });
  }
  await page.locator(sel.password).first().fill(creds.password ?? "");
  const sentAt = new Date();
  await page.locator(sel.submit).first().click();

  // Signed in, a second factor, a CAPTCHA, or an error: whichever shows first.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await visible(page, sel.signedIn)) return;
    await checkCaptcha(page, sel);
    if (await visible(page, sel.error)) throw new Error(`${label} refused the sign-in: ${((await page.locator(sel.error!).first().textContent()) ?? "").trim().slice(0, 160)}`);
    if (await visible(page, sel.totpInput)) {
      if (!creds.totpSecret) throw new NeedsPerson(`${label} asks for an authenticator code and no authenticator secret is saved`);
      // A code about to expire is waited out so it is not rejected on arrival.
      if (totpSecondsLeft() < 5) await page.waitForTimeout(totpSecondsLeft() * 1000 + 500);
      await ctx.step("second factor", "Entering the authenticator code");
      await page.locator(sel.totpInput!).first().fill(totp(creds.totpSecret));
      await submitCode(page, sel);
      if (await visible(page, sel.signedIn, 20_000)) return;
      throw new Error(`${label} did not accept the authenticator code (check the saved secret and the engine clock)`);
    }
    if (await visible(page, sel.emailCodeInput)) {
      if (!creds.emailCodeTo) throw new NeedsPerson(`${label} emailed a sign-in code and no "email code goes to" address at our domain is saved`);
      await ctx.step("email code", `Waiting for ${label}'s sign-in code at ${creds.emailCodeTo} (up to 3 minutes)`);
      const code = await waitForEmailCode(creds.emailCodeTo, sentAt, sel.emailFrom ?? new RegExp(label.split(/\s/)[0]!, "i"));
      await page.locator(sel.emailCodeInput!).first().fill(code);
      await submitCode(page, sel);
      if (await visible(page, sel.signedIn, 20_000)) return;
      throw new Error(`${label} did not accept the emailed code`);
    }
    if ((await visible(page, 'input[autocomplete="one-time-code"], input[name*="otp" i]')) || (await visible(page, "text=/security key|passkey|approve.*(phone|device)|text message/i"))) {
      throw new NeedsPerson(`${label} asks for a second factor we cannot answer here (SMS, a passkey or a device approval); switch the account to an authenticator app or email code`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: still not signed in 30 seconds after submitting the login`);
}

async function submitCode(page: Page, sel: PortalSelectors): Promise<void> {
  if (sel.codeSubmit && (await visible(page, sel.codeSubmit))) await page.locator(sel.codeSubmit).first().click();
  else await page.keyboard.press("Enter");
}

/** The first dollar figure after a label in the page text ("Amount due $123.45"). */
export async function amountNear(page: Page, label: RegExp): Promise<number | null> {
  const text = (await page.locator("body").innerText().catch(() => "")) ?? "";
  const m = new RegExp(`${label.source}[^$\\d]{0,60}\\$\\s?([\\d,]+(?:\\.\\d{2})?)`, label.flags.includes("i") ? "i" : "").exec(text);
  return m ? Math.round(Number(m[1]!.replace(/,/g, "")) * 100) : null;
}

/** Download what a link or button gives: a browser download, or the URL's bytes when it is a plain link. */
export async function downloadFrom(page: Page, target: Locator): Promise<Buffer | null> {
  const href = await target.getAttribute("href").catch(() => null);
  if (href && !href.startsWith("javascript")) {
    const res = await page.context().request.get(new URL(href, page.url()).toString(), { timeout: 60_000 });
    if (res.ok()) {
      const body = await res.body();
      if (body.subarray(0, 4).toString() === "%PDF" || /csv|text\/plain/.test(res.headers()["content-type"] ?? "")) return body;
    }
  }
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 45_000 }), target.click()]);
  const path = await dl.path();
  if (!path) return null;
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

/**
 * Open a browser, run `fn`, close it. A failing step is rethrown with its name, after a screenshot of the page is
 * stored (vendor-screens/<vendor>/<time>.png) and handed to ctx.screenshot.
 */
export async function withPortal<T>(vendor: string, ctx: CollectContext, fn: (p: Portal) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 1000 }, locale: "en-US", timezoneId: "America/New_York" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  let current = "open";
  const portal: Portal = {
    page,
    context,
    step: async (name, line, run) => {
      current = name;
      await ctx.step(name, line);
      return run();
    },
  };
  try {
    return await fn(portal);
  } catch (e) {
    try {
      const shot = await page.screenshot({ fullPage: true, timeout: 10_000 });
      const key = await putVendorFile(`vendor-screens/${vendor}/${new Date().toISOString().replace(/[:.]/g, "-")}.png`, shot, "image/png");
      if (key) ctx.screenshot?.(key);
    } catch (se) {
      log.debug({ err: se, vendor }, "vendor screenshot failed");
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof NeedsPerson) throw e;
    throw new Error(`At "${current}": ${msg.split("\n")[0]!.slice(0, 300)}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Invoices behind Stripe-hosted links on a billing page (most SaaS portals list them that way): each link opens
 * invoice.stripe.com, whose "Download invoice" gives the PDF. Newest first, at most `max`.
 */
export async function stripeInvoicePdfs(page: Page, max = 3): Promise<Buffer[]> {
  const hrefs = await page
    .locator('a[href*="invoice.stripe.com"], a[href*="pay.stripe.com/invoice"], a[href*="/invoices/"][href$=".pdf"], a[href*="invoice"][download]')
    .evaluateAll((els) => els.map((e) => (e as unknown as { href: string }).href).filter(Boolean));
  const out: Buffer[] = [];
  for (const href of [...new Set(hrefs)].slice(0, max)) {
    if (/\.pdf($|\?)/i.test(href)) {
      const res = await page.context().request.get(href, { timeout: 60_000 });
      if (res.ok()) out.push(await res.body());
      continue;
    }
    const tab = await page.context().newPage();
    try {
      await tab.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const button = tab.locator('button:has-text("Download invoice"), a:has-text("Download invoice"), button:has-text("Download PDF"), a:has-text("Download PDF")').first();
      await button.waitFor({ state: "visible", timeout: 20_000 });
      const bytes = await downloadFrom(tab, button);
      if (bytes && bytes.subarray(0, 4).toString() === "%PDF") out.push(bytes);
    } catch (e) {
      log.debug({ err: e, href }, "stripe invoice download failed");
    } finally {
      await tab.close().catch(() => undefined);
    }
  }
  return out;
}
