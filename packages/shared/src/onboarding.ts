// Client onboarding wizard (owner, 6 Nov: "wizard-driven ... they can jump
// around and skip around; name and email are the only minimum; everything
// else is optional but needed to get set up ... tell them we need about 7
// days ... it ends with putting in a credit card").
//
// The rules (which step is done, what is still needed, the timeline, the
// recommended prepayment, calling hours against state rules) are pure and
// tested in `onboarding.test.ts`. The answers live on `Tenant.onboarding`
// (JSON, read with `readOnboarding`). See docs/HANDOFF.md "Client onboarding
// wizard".
import { FEDERAL_RULE, ruleForState, type StateRuleDef } from "./compliance/state-rules";
import { blocking, registrationTone, validateBrand, websiteProblems, type BrandFields, type CampaignFields, type WebsiteFindings } from "./tendlc";

/**
 * Paused by the owner on 6 Nov (merchant account about a week away). While
 * false, nothing sends a client to the wizard by itself: no first-visit
 * redirect from /dashboard, no redirect after sign-up, no "Finish setup"
 * banner, no welcome email when the owner creates a workspace. /welcome still
 * works when opened directly, from Settings, or with "Open wizard" on
 * /platform. Turn it on once the wizard has been walked through live.
 */
export const ONBOARDING_WIZARD_LIVE = false;

export const STEP_KEYS = ["you", "business", "texting", "calling", "leads", "team", "payment", "done"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
/** The steps that count towards progress (Done is the summary). */
export const COUNTED_STEPS = STEP_KEYS.filter((k) => k !== "done") as Exclude<StepKey, "done">[];

export interface StepDef {
  key: StepKey;
  title: string;
  /** One plain-English line on why we ask. */
  why: string;
  /** What it unlocks; shown as "Needed for …". */
  neededFor: string;
}

export const ONBOARDING_STEPS: StepDef[] = [
  { key: "you", title: "You", why: "So we know who to talk to about your account. Your name and email are all we need to keep your workspace.", neededFor: "your workspace (required)" },
  { key: "business", title: "Business", why: "Phone carriers only carry business texts from a registered, verified business; the same details go on the Free Caller Registry so your calls are not labelled spam.", neededFor: "texting registration (10DLC) and the Free Caller Registry" },
  { key: "texting", title: "Texting", why: "Carriers review what you will text and how people agree to it before they let your numbers send texts.", neededFor: "texting from your numbers" },
  { key: "calling", title: "Calling", why: "We name your first campaign, set its calling hours and check the states you call against their telemarketing rules.", neededFor: "your first campaign" },
  { key: "leads", title: "Your leads", why: "With your file loaded we can see your leads' area codes and get local numbers for them, so people see a nearby number.", neededFor: "local caller-ID numbers" },
  { key: "team", title: "Team", why: "Invite the agents and supervisors who will dial; each gets their own sign-in.", neededFor: "agents dialing" },
  { key: "payment", title: "Payment", why: "Strowger is prepaid: dialing and new numbers start once your first payment lands.", neededFor: "dialing and ordering numbers" },
  { key: "done", title: "Done", why: "What is live now, what is still being reviewed, and what to do next.", neededFor: "" },
];
export const stepDef = (k: StepKey) => ONBOARDING_STEPS.find((s) => s.key === k)!;

export const TIMELINE_TEXT =
  "Most clients are fully live in about 7 days: texting registration (10DLC) usually takes about 3 business days; numbers and dialing are ready the same day once you add funds.";
export const LIVE_DAYS = 7;
export const TENDLC_BUSINESS_DAYS = 3;

// ─────────────────────────────── The stored answers ───────────────────────────────

export interface YouData {
  name?: string;
  email?: string;
  mobile?: string;
  title?: string;
}
export interface BusinessData extends BrandFields {
  yearFounded?: string;
  employees?: string;
}
export type TextingData = CampaignFields;
export interface CallingData {
  about?: string;
  campaignName?: string;
  /** Local hour 0–23 they would like to start / stop (exclusive). */
  hoursStart?: number;
  hoursEnd?: number;
  states?: string[];
  inbound?: "yes" | "no" | "";
  /** Agents who will dial, for the recommended prepayment. */
  agents?: number;
}
export interface LeadsData {
  hasFile?: "yes" | "no" | "";
}
export interface TeamInvite {
  email: string;
  name?: string;
  role: "AGENT" | "SUPERVISOR";
  userId?: string;
  sentAt?: string;
  error?: string;
}
export interface TeamData {
  invites?: TeamInvite[];
}
export interface PaymentData {
  amountCents?: number;
  method?: "card" | "wire" | "";
}
export interface StepMeta {
  updatedAt?: string;
  skippedAt?: string | null;
}

export interface OnboardingState {
  steps: { you?: YouData; business?: BusinessData; texting?: TextingData; calling?: CallingData; leads?: LeadsData; team?: TeamData; payment?: PaymentData };
  meta: Partial<Record<StepKey, StepMeta>>;
  firstSeenAt?: string;
  /** Pressed Finish on the Done step; the "Finish setup" banner goes. */
  finishedAt?: string;
  /** Last website check (engine `onboarding/website.ts`). */
  website?: WebsiteFindings;
  registration?: {
    brandSubmittedAt?: string;
    campaignSubmittedAt?: string;
    /** Brand in, campaign waiting for the brand's verification (the engine retries). */
    campaignPending?: boolean;
    error?: string;
    submittedById?: string;
  };
  firstCampaign?: { campaignId: string; listId: string; createdAt: string };
  /** "Reserve these numbers": done, or saved until the first payment lands. */
  reserve?: { state: "pending_funds" | "ordering" | "applied" | "failed"; savedAt: string; appliedAt?: string; poolFirst: boolean; exactOnly: boolean; summary?: string; userId?: string };
  paymentRequest?: { amountCents: number; requestedAt: string; provider: string };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** `Tenant.onboarding` as stored (null on a workspace that never opened the wizard) → a state with its maps present. */
export function readOnboarding(json: unknown): OnboardingState {
  const o = obj(json);
  return { ...(o as Partial<OnboardingState>), steps: obj(o.steps) as OnboardingState["steps"], meta: obj(o.meta) as OnboardingState["meta"] };
}

// ─────────────────────────────── Status ───────────────────────────────

export type StepStatus = "done" | "needs" | "skipped" | "todo";

/** Facts the wizard's answers do not hold. */
export interface StepContext {
  /** Balance above zero (or a payment recorded). */
  funded: boolean;
  /** Leads in the first campaign's lists. */
  leadCount: number;
  /** People invited (any role but the admin) in the workspace. */
  invitedCount: number;
  /** Telnyx status of the 10DLC campaign, else the brand. */
  registrationStatus?: string | null;
}

const isEmail = (s: string | undefined) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? "").trim());

/** The two things a workspace may not be without. */
export function requiredMissing(s: OnboardingState): string[] {
  const y = s.steps.you ?? {};
  const out: string[] = [];
  if (!String(y.name ?? "").trim()) out.push("contact name");
  if (!isEmail(y.email)) out.push("email");
  return out;
}

const touched = (s: OnboardingState, k: StepKey) => Boolean(s.meta[k]?.updatedAt);
const skipped = (s: OnboardingState, k: StepKey) => Boolean(s.meta[k]?.skippedAt);

/** Brand problems blocking 10DLC, website findings included (a missing check counts). */
export function businessBlocking(b: BusinessData | undefined, site: WebsiteFindings | undefined) {
  const brand = blocking(validateBrand(b ?? {}));
  const web = blocking(websiteProblems(site));
  return { brand, web, siteChecked: Boolean(site) };
}

export function stepStatus(key: StepKey, s: OnboardingState, ctx: StepContext): StepStatus {
  const fallback = (done: boolean): StepStatus => (done ? "done" : skipped(s, key) ? "skipped" : touched(s, key) ? "needs" : "todo");
  switch (key) {
    case "you":
      return requiredMissing(s).length ? "needs" : "done";
    case "business": {
      const b = businessBlocking(s.steps.business, s.website);
      return fallback(b.brand.length === 0 && b.siteChecked && b.web.length === 0);
    }
    case "texting":
      return fallback(Boolean(s.registration?.campaignSubmittedAt) || registrationTone(ctx.registrationStatus) === "approved");
    case "calling": {
      const c = s.steps.calling ?? {};
      return fallback(Boolean(String(c.about ?? "").trim()) && (c.states?.length ?? 0) > 0 && validHours(c.hoursStart, c.hoursEnd));
    }
    case "leads":
      if (ctx.leadCount > 0) return "done";
      if (s.steps.leads?.hasFile === "no") return "skipped";
      return fallback(false);
    case "team":
      return fallback(ctx.invitedCount > 0);
    case "payment":
      return fallback(ctx.funded || Boolean(s.paymentRequest));
    case "done":
      return s.finishedAt ? "done" : "todo";
  }
}

const validHours = (a: number | undefined, b: number | undefined) => Number.isInteger(a) && Number.isInteger(b) && (a as number) >= 0 && (b as number) <= 24 && (a as number) < (b as number);

export interface Progress {
  statuses: Record<StepKey, StepStatus>;
  done: number;
  total: number;
  pct: number;
  /** Every counted step done, or Finish pressed. */
  complete: boolean;
  missingRequired: string[];
}

export function onboardingProgress(s: OnboardingState, ctx: StepContext): Progress {
  const statuses = Object.fromEntries(STEP_KEYS.map((k) => [k, stepStatus(k, s, ctx)])) as Record<StepKey, StepStatus>;
  const done = COUNTED_STEPS.filter((k) => statuses[k] === "done").length;
  const total = COUNTED_STEPS.length;
  return { statuses, done, total, pct: Math.round((done / total) * 100), complete: Boolean(s.finishedAt) || done === total, missingRequired: requiredMissing(s) };
}

// ─────────────────────────────── Timeline ───────────────────────────────

/** `n` business days after `from` (Saturday and Sunday skipped; holidays not counted). */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

const day = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The persistent box, plus dates once the clock has started (`start` = first visit, `textingFrom` = 10DLC submitted). */
export function timeline(start: Date, textingFrom: Date | null) {
  const liveBy = new Date(start.getTime() + LIVE_DAYS * 86_400_000);
  const textingBy = textingFrom ? addBusinessDays(textingFrom, TENDLC_BUSINESS_DAYS) : null;
  const lines = [TIMELINE_TEXT, `Started ${day(start)}: expect to be fully live by about ${day(liveBy)}.`];
  if (textingBy) lines.push(`Texting registration sent ${day(textingFrom!)}: carriers usually answer by ${day(textingBy)}.`);
  return { liveBy, textingBy, lines };
}

// ─────────────────────────────── Recommended prepayment ───────────────────────────────

export const PREPAY_DEFAULTS = {
  /** Billed (connected) minutes an agent averages per working day: answered calls and voicemails, both directions. */
  minutesPerSeatPerDay: 180,
  workDaysPerMonth: 21,
  /** Rounded up to this. */
  roundToCents: 10_000,
  minimumCents: 10_000,
} as const;

export interface PrepayInput {
  seats: number;
  seatMonthlyCents: number;
  /** Price per billed minute, millicents (1200 = 1.2¢). */
  perMinuteMillicents: number;
  numbers: number;
  /** Price per number per month, cents. */
  numberMonthlyCents: number;
  minutesPerSeatPerDay?: number;
  workDaysPerMonth?: number;
}

/** One month: seats × plan + estimated minutes + numbers, rounded up to the next $100. */
export function recommendedPrepayment(i: PrepayInput) {
  const seats = Math.max(0, Math.floor(i.seats || 0));
  const numbers = Math.max(0, Math.floor(i.numbers || 0));
  const perDay = i.minutesPerSeatPerDay ?? PREPAY_DEFAULTS.minutesPerSeatPerDay;
  const days = i.workDaysPerMonth ?? PREPAY_DEFAULTS.workDaysPerMonth;
  const minutes = seats * perDay * days;
  const seatsCents = seats * i.seatMonthlyCents;
  const minutesCents = Math.round((minutes * i.perMinuteMillicents) / 1000);
  const numbersCents = numbers * i.numberMonthlyCents;
  const totalCents = seatsCents + minutesCents + numbersCents;
  const step = PREPAY_DEFAULTS.roundToCents;
  const recommendedCents = Math.max(PREPAY_DEFAULTS.minimumCents, Math.ceil(totalCents / step) * step);
  return {
    seats,
    numbers,
    minutes,
    lines: [
      { label: `${seats} seat${seats === 1 ? "" : "s"} × ${money(i.seatMonthlyCents)} a month`, cents: seatsCents },
      { label: `About ${minutes.toLocaleString("en-US")} minutes (${perDay} a seat a day × ${days} working days) at ${(i.perMinuteMillicents / 1000).toFixed(1)}¢`, cents: minutesCents },
      { label: `${numbers} number${numbers === 1 ? "" : "s"} × ${money(i.numberMonthlyCents)} a month`, cents: numbersCents },
    ],
    totalCents,
    recommendedCents,
  };
}

export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─────────────────────────────── Calling hours against state rules ───────────────────────────────

const hour = (h: number) => (h === 0 || h === 24 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface StateNote {
  state: string;
  /** The window Strowger will actually dial in, weekdays. */
  start: number;
  end: number;
  /** Their preference is wider than the law allows here. */
  clipped: boolean;
  lines: string[];
  hasRule: boolean;
}

/** For each state they call: the window that applies (the most restrictive wins), day rules and attempt caps. */
export function callingNotes(hoursStart: number, hoursEnd: number, states: string[]): StateNote[] {
  return [...new Set(states.map((s) => s.trim().toUpperCase()).filter(Boolean))].sort().map((st) => {
    const rule: StateRuleDef = ruleForState(st) ?? FEDERAL_RULE;
    const start = Math.max(hoursStart, rule.startHour, FEDERAL_RULE.startHour);
    const end = Math.min(hoursEnd, rule.endHour, FEDERAL_RULE.endHour);
    const clipped = start > hoursStart || end < hoursEnd;
    const lines: string[] = [];
    lines.push(`${ruleForState(st) ? st : `${st} (federal rule)`}: ${hour(rule.startHour)} to ${hour(rule.endHour)} lead's local time${rule.citation ? ` (${rule.citation})` : ""}.`);
    if (clipped) lines.push(`Your ${hour(hoursStart)}–${hour(hoursEnd)} is wider: Strowger dials ${hour(start)}–${hour(end)} there.`);
    for (const [d, o] of Object.entries(rule.dayOverrides ?? {})) lines.push(o ? `${DAY[Number(d)]}: ${hour(o.startHour)} to ${hour(o.endHour)} only.` : `No calls on ${DAY[Number(d)]}s.`);
    if (rule.noHolidayCalls) lines.push("No calls on state holidays.");
    if (rule.maxAttemptsPerDay) lines.push(`At most ${rule.maxAttemptsPerDay} calls (and texts) to one person in 24 hours.`);
    return { state: st, start, end, clipped, lines, hasRule: Boolean(ruleForState(st)) };
  });
}
