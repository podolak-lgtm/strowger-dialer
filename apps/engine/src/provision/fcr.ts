// Register numbers at the Free Caller Registry (First Orion, Hiya, TNS) by
// driving their web form: it has no API. The form emails a five-character
// code to the business contact address; ours is an address at
// crossbar.digital, which Crossbar's inbox keeps, so the engine reads the
// code back through Crossbar's agent API and finishes the form.
//
// The owner's certification ("my business makes calls from the submitted
// phone numbers") is made with the profile the owner saved in Settings; the
// run is logged with the registry's feedback id.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@strowger/db";
import { chromium } from "playwright";
import { config } from "../config";
import { log } from "../log";
import { redis } from "../redis";

export interface FcrProfile {
  contactEmail: string;
  companyName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  website: string;
  contactName: string;
  contactPhone: string;
  /** Registry categories: attorney_legal, financial_service, informational, real_estate, survey, telemarketing, … */
  category: string;
  /** Registry ranges: 1, 101, 501, 1001, 5001, 10001, 50001, dontknow */
  callCount: string;
  explanation?: string;
}

/** Progress of a run, for the DIDs page to poll. Kept in Redis for a day. */
export interface FcrProgress {
  state: "running" | "done" | "failed";
  step: string;
  log: { at: string; line: string }[];
  startedAt: string;
  finishedAt?: string;
  result?: FcrResult;
}
const progressKey = (tenantId: string) => `fcr:progress:${tenantId}`;
export async function fcrProgress(tenantId: string): Promise<FcrProgress | null> {
  const raw = await redis.get(progressKey(tenantId));
  return raw ? (JSON.parse(raw) as FcrProgress) : null;
}
async function note(tenantId: string, p: FcrProgress, step: string, line: string): Promise<void> {
  p.step = step;
  p.log.push({ at: new Date().toISOString(), line });
  await redis.set(progressKey(tenantId), JSON.stringify(p), "EX", 86_400);
}

/** Start a run in the background; the page polls fcrProgress. Refuses while one is running. */
export async function startFcrRun(tenantId: string, ids?: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const cur = await fcrProgress(tenantId);
  if (cur?.state === "running" && Date.now() - new Date(cur.startedAt).getTime() < 15 * 60_000) return { ok: false, error: "A registry run is already in progress" };
  const p: FcrProgress = { state: "running", step: "starting", log: [], startedAt: new Date().toISOString() };
  await note(tenantId, p, "starting", "Starting the registry run");
  void registerAtFcr(tenantId, ids, (step, line) => note(tenantId, p, step, line)).then(async (result) => {
    p.state = result.ok ? "done" : "failed";
    p.result = result;
    p.finishedAt = new Date().toISOString();
    await note(tenantId, p, result.ok ? "done" : "failed", result.ok ? `Registered ${result.count} numbers. Feedback id ${result.feedbackId}.` : `Stopped at "${result.step}": ${result.error}`);
  });
  return { ok: true };
}

export interface FcrResult {
  ok: boolean;
  feedbackId?: string;
  count: number;
  phones: string[];
  error?: string;
  step?: string;
}

const FORM_URL = "https://www.freecallerregistry.com/fcr/";
const REQUIRED: (keyof FcrProfile)[] = ["contactEmail", "companyName", "address1", "city", "state", "zip", "website", "contactName", "contactPhone", "category"];

export function profileProblems(p: Partial<FcrProfile> | null | undefined): string[] {
  if (!p) return ["No Free Caller Registry profile saved in Settings"];
  const out = REQUIRED.filter((k) => !String(p[k] ?? "").trim()).map((k) => `${k} is empty`);
  if (p.contactEmail && !/^[^@\s]+@[^@\s]+$/.test(p.contactEmail)) out.push("contactEmail is not an address");
  return out;
}

/** The code the registry emailed, read from Crossbar's inbox. */
async function waitForCode(toAddress: string, since: Date, timeoutMs = 4 * 60_000): Promise<string> {
  if (!config.CROSSBAR_URL || !config.CROSSBAR_AGENT_KEY) throw new Error("CROSSBAR_URL / CROSSBAR_AGENT_KEY are not set, so the verification email cannot be read");
  const deadline = Date.now() + timeoutMs;
  const url = new URL("/api/agent/inbox", config.CROSSBAR_URL);
  url.searchParams.set("to", toAddress.toLowerCase());
  url.searchParams.set("since", new Date(since.getTime() - 60_000).toISOString());
  url.searchParams.set("limit", "10");
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.CROSSBAR_AGENT_KEY}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Crossbar inbox: ${res.status} ${(await res.text()).slice(0, 120)}`);
    const { emails } = (await res.json()) as { emails: { from: string; subject: string; text: string; receivedAt: string }[] };
    for (const e of emails) {
      const blob = `${e.subject}\n${e.text}`;
      if (!/caller\s*registry|verification|freecallerregistry/i.test(`${e.from}\n${blob}`)) continue;
      // "Your verification code is: AB12C" or a bare 5-character token near the word code.
      const near = /code[^A-Za-z0-9]{0,40}([A-Za-z0-9]{5})\b/i.exec(blob)?.[1] ?? /\b([A-Z0-9]{5})\b/.exec(blob.replace(/\b(https?:\S+)/g, ""))?.[1];
      if (near) return near;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`No verification email reached ${toAddress} within ${Math.round(timeoutMs / 60_000)} minutes`);
}

/** Register every unregistered number (or the ids given). Takes a few minutes; call it from a route that does not time out. */
export async function registerAtFcr(tenantId: string, ids?: string[], onStep: (step: string, line: string) => Promise<void> | void = () => undefined): Promise<FcrResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const profile = ((tenant.settings ?? {}) as { fcr?: Partial<FcrProfile> }).fcr;
  const problems = profileProblems(profile);
  if (problems.length) return { ok: false, count: 0, phones: [], error: `Profile incomplete: ${problems.join(", ")}`, step: "profile" };
  const p = profile as FcrProfile;
  const rows = await prisma.callerIdNumber.findMany({
    where: { tenantId, status: { not: "RETIRED" }, registeredAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
    orderBy: { phone: "asc" },
    select: { id: true, phone: true },
  });
  if (rows.length === 0) return { ok: false, count: 0, phones: [], error: "No unregistered numbers", step: "numbers" };
  const phones = rows.map((r) => r.phone);

  const dir = await mkdtemp(path.join(tmpdir(), "fcr-"));
  const file = path.join(dir, "numbers.txt");
  await writeFile(file, phones.join("\r\n") + "\r\n", "utf8");
  await onStep("open", `Opening the registry form for ${phones.length} number${phones.length === 1 ? "" : "s"}`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  let step = "open";
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    page.setDefaultTimeout(30_000);
    await page.goto(FORM_URL, { waitUntil: "networkidle", timeout: 60_000 });

    step = "send code";
    await onStep(step, `Asking the registry to email a code to ${p.contactEmail}`);
    const sentAt = new Date();
    await page.fill("#enterprise_contact_verification_email", p.contactEmail);
    await page.click("#new-send-verification-code");
    await page.waitForSelector("#captcha", { state: "visible" });

    step = "read code";
    await onStep(step, "Waiting for the code to arrive in Crossbar's inbox (up to 4 minutes)");
    const code = await waitForCode(p.contactEmail, sentAt);
    log.info({ tenantId }, "fcr: verification code received");

    step = "verify";
    await onStep(step, "Code received; verifying");
    await page.fill("#captcha", code);
    await page.click("#verifyAndContinue");
    await page.waitForSelector("#enterprise_company_name", { state: "visible", timeout: 20_000 });

    step = "business details";
    await onStep(step, `Filling in business details for ${p.companyName}`);
    await page.fill("#enterprise_company_name", p.companyName);
    await page.fill("#enterprise_company_address_line_1", p.address1);
    if (p.address2) await page.fill("#enterprise_company_address_line_2", p.address2);
    await page.fill("#enterprise_company_address_city", p.city);
    await page.selectOption("#enterprise_company_address_state", p.state.toUpperCase());
    await page.fill("#enterprise_company_address_zip", p.zip);
    await page.fill("#enterprise_company_url", p.website);
    await page.fill("#enterprise_contact_name", p.contactName);
    await page.fill("#enterprise_contact_phone", p.contactPhone);
    await page.selectOption("#enterprise_category", p.category);
    if (p.callCount) await page.selectOption("#call_count", p.callCount);
    if (p.explanation) await page.fill("#additional_feedback", p.explanation);
    await page.click("#nextButton1");
    // Either step 2 appears, or the address validator complains.
    await Promise.race([page.waitForSelector("#tab2", { state: "visible" }), page.waitForSelector("#container-address-error:not(:empty), .error:visible", { timeout: 15_000 }).catch(() => null)]);
    if (!(await page.isVisible("#tab2"))) {
      const err = (await page.textContent("#container-address-error").catch(() => null))?.trim() || (await page.locator(".error:visible").first().textContent().catch(() => null))?.trim() || "the form did not accept the business details";
      throw new Error(`Business details rejected: ${err}`);
    }

    step = "upload numbers";
    await onStep(step, "Uploading the numbers file");
    await page.click("#tab2");
    await page.setInputFiles("#enterpriseFile", file);
    await page.click("#nextButton2");
    await Promise.race([page.waitForSelector("#enableCheckbox", { state: "visible" }), page.waitForSelector(".error:visible", { timeout: 15_000 }).catch(() => null)]);
    if (!(await page.isVisible("#enableCheckbox"))) {
      const err = (await page.locator(".error:visible").first().textContent().catch(() => null))?.trim() || "the form did not accept the numbers file";
      throw new Error(`Numbers rejected: ${err}`);
    }

    step = "submit";
    await onStep(step, "Accepting the terms and submitting");
    await page.check("#enableCheckbox");
    await page.click("#submitButton");
    await page.waitForFunction('(() => { const el = document.querySelector(".feedback-id"); const t = el && el.textContent ? el.textContent.trim() : ""; return t !== "" && t !== "[]"; })()', undefined, { timeout: 60_000 });
    const feedbackId = ((await page.textContent(".feedback-id")) ?? "").trim();

    const now = new Date();
    await prisma.callerIdNumber.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { registeredAt: now } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...((tenant.settings ?? {}) as object), fcr: { ...p, lastSubmission: { feedbackId, at: now.toISOString(), count: phones.length } } } } });
    log.info({ tenantId, feedbackId, count: phones.length }, "fcr: registered");
    return { ok: true, feedbackId, count: phones.length, phones };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ tenantId, step, err: msg }, "fcr: failed");
    return { ok: false, count: phones.length, phones, error: msg.slice(0, 400), step };
  } finally {
    await browser.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
