// 10DLC (A2P texting registration with The Campaign Registry, through Telnyx):
// the rules a brand and a campaign are checked against before they are
// submitted. One place for the Numbers page form and the onboarding wizard
// (owner, 6 Nov: "you did a great job making sure everything was filled out
// correctly, double-checking the website and flagging what wouldn't work").
//
// Pure: no network. The website is fetched by the engine
// (`apps/engine/src/onboarding/website.ts`); what it found is judged here by
// `analyzeSite` + `websiteProblems`, so the judgement is tested.
//
// Every problem names the field, says what is wrong and how to fix it.
// `error` = TCR or the carriers will reject it; `warn` = likely to be
// rejected or delayed, worth fixing.
import { STATE_ZONE } from "./geo/data";
import { stateForZip } from "./geo/index";
import { normalizePhone } from "./phone";
import { FREE_MAIL_DOMAINS } from "./referrals";

export type ProblemLevel = "error" | "warn";
export interface Problem {
  field: string;
  level: ProblemLevel;
  message: string;
  fix: string;
}

export const ENTITY_TYPES = [
  ["PRIVATE_PROFIT", "Private company (LLC, Inc., Corp.)"],
  ["PUBLIC_PROFIT", "Public company (listed on a stock exchange)"],
  ["NON_PROFIT", "Non-profit"],
  ["SOLE_PROPRIETOR", "Sole proprietor (no EIN)"],
  ["GOVERNMENT", "Government"],
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number][0];

export const VERTICALS = ["INSURANCE", "FINANCIAL", "REAL_ESTATE", "LEGAL", "HEALTHCARE", "EDUCATION", "RETAIL", "PROFESSIONAL", "TECHNOLOGY", "ENERGY", "CONSTRUCTION", "HOSPITALITY", "COMMUNICATION", "AGRICULTURE", "ENTERTAINMENT", "HUMAN_RESOURCES", "MANUFACTURING", "NGO", "POLITICAL", "POSTAL", "TRANSPORTATION", "GAMBLING", "GOVERNMENT"] as const;

export const USECASES: [string, string][] = [
  ["LOW_VOLUME", "Low volume mixed (under 2,000 msgs/day; fastest approval)"],
  ["MIXED", "Mixed: marketing + customer care"],
  ["MARKETING", "Marketing / promotions"],
  ["CUSTOMER_CARE", "Customer care (support, account)"],
  ["ACCOUNT_NOTIFICATION", "Account notifications"],
  ["DELIVERY_NOTIFICATION", "Delivery notifications"],
  ["2FA", "Two-factor authentication"],
  ["POLLING_VOTING", "Polling / voting"],
  ["PUBLIC_SERVICE_ANNOUNCEMENT", "Public service announcement"],
];

/** Daily message ceiling of the LOW_VOLUME use case (TCR). */
export const LOW_VOLUME_DAILY_MAX = 2000;

export const OPT_IN_METHODS = [
  ["WEB_FORM", "A form on our website"],
  ["VERBAL", "Verbally, on a call"],
  ["KEYWORD", "They text a keyword to us"],
  ["PAPER", "A paper or in-person form"],
] as const;
export type OptInMethod = (typeof OPT_IN_METHODS)[number][0];

/** Keyword lists sent to TCR; they match what `sms.ts` honours on inbound texts. */
export const OPT_OUT_KEYWORDS = "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT";
export const HELP_KEYWORDS = "HELP,INFO";
export const OPT_IN_KEYWORDS = "START,YES,UNSTOP";

// ─────────────────────────────── Brand ───────────────────────────────

export interface BrandFields {
  entityType?: string;
  legalName?: string;
  dba?: string;
  ein?: string;
  vertical?: string;
  website?: string;
  phone?: string;
  supportEmail?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  /** Sole proprietors register as a person. */
  firstName?: string;
  lastName?: string;
  stockSymbol?: string;
  stockExchange?: string;
}

/** IRS EIN prefixes that have never been assigned (a typo, or not an EIN). */
const UNUSED_EIN_PREFIXES = new Set(["00", "07", "08", "09", "17", "18", "19", "28", "29", "49", "69", "70", "78", "79", "89", "96", "97"]);
export const US_STATES = new Set(Object.keys(STATE_ZONE));

const blank = (v: string | undefined | null) => !String(v ?? "").trim();
const LEGAL_SUFFIX = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|l\.?l\.?p|l\.?p|p\.?c|p\.?a|pllc|plc|trust|foundation|association|group)\.?$/i;

/** "12-3456789" from anything with nine digits; null when it is not nine digits. */
export function formatEin(raw: string | undefined | null): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : null;
}

export function einProblems(ein: string | undefined, entityType: string | undefined): Problem[] {
  if (entityType === "SOLE_PROPRIETOR") {
    return blank(ein) ? [] : [{ field: "ein", level: "warn", message: "Sole proprietors register without an EIN.", fix: "Leave the EIN empty, or pick the entity type the EIN belongs to (an LLC with one owner is a private company)." }];
  }
  if (blank(ein)) return [{ field: "ein", level: "error", message: "The EIN (federal tax id) is required for this entity type.", fix: "Copy it from the IRS letter (CP-575 or 147C), nine digits like 12-3456789." }];
  const f = formatEin(ein);
  if (!f) return [{ field: "ein", level: "error", message: "An EIN is nine digits.", fix: "Type it as 12-3456789; a Social Security number is not accepted." }];
  if (UNUSED_EIN_PREFIXES.has(f.slice(0, 2))) return [{ field: "ein", level: "error", message: `No EIN starts with ${f.slice(0, 2)}.`, fix: "Check the first two digits against the IRS letter." }];
  if (/^(\d)\1-?\1{7}$/.test(f.replace("-", "")) || f.replace("-", "") === "123456789") return [{ field: "ein", level: "error", message: "That looks like a placeholder, not a real EIN.", fix: "Enter the EIN from the IRS letter." }];
  return [];
}

export function websiteFormatProblems(website: string | undefined): Problem[] {
  if (blank(website)) return [{ field: "website", level: "error", message: "A website is required: carriers read it to confirm the business and how people opt in.", fix: "Enter the address of your business website, starting https://." }];
  const raw = String(website).trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return [{ field: "website", level: "error", message: "That is not a web address.", fix: "Use the form https://yourbusiness.com." }];
  }
  const out: Problem[] = [];
  if (!u.hostname.includes(".")) out.push({ field: "website", level: "error", message: "That is not a web address.", fix: "Use the form https://yourbusiness.com." });
  if (/(^|\.)(facebook|instagram|linkedin|twitter|x|tiktok|yelp|google)\.com$/i.test(u.hostname) || /^(linktr\.ee|sites\.google\.com)$/i.test(u.hostname)) {
    out.push({ field: "website", level: "error", message: "A social-media or listing page is not accepted as the business website.", fix: "Use the business's own website, with its privacy policy and terms pages." });
  }
  if (/^http:\/\//i.test(raw)) out.push({ field: "website", level: "warn", message: "The website is not on https.", fix: "Use the https:// address; carriers flag sites without a certificate." });
  return out;
}

/** The address a URL is normalised to for fetching and display ("acme.com" → "https://acme.com/"). Null when unusable. */
export function normalizeWebsite(website: string | undefined | null): string | null {
  const raw = String(website ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const domainOf = (url: string | undefined | null) => {
  const n = normalizeWebsite(url);
  return n ? new URL(n).hostname.replace(/^www\./, "").toLowerCase() : null;
};

/** Checks on a brand as typed. Nothing here needs the network. */
export function validateBrand(b: BrandFields): Problem[] {
  const out: Problem[] = [];
  const entity = b.entityType || "PRIVATE_PROFIT";
  if (!ENTITY_TYPES.some(([k]) => k === entity)) out.push({ field: "entityType", level: "error", message: "Pick the kind of business.", fix: "Choose one of the entity types." });

  if (entity === "SOLE_PROPRIETOR") {
    if (blank(b.firstName) || blank(b.lastName)) out.push({ field: "firstName", level: "error", message: "A sole proprietor registers under the owner's own name.", fix: "Enter the owner's first and last name (the You step's contact name is used when it is the owner)." });
  } else if (blank(b.legalName)) {
    out.push({ field: "legalName", level: "error", message: "The legal business name is required.", fix: "Type it exactly as it is on the IRS letter for the EIN, including LLC, Inc. and punctuation." });
  } else {
    const name = String(b.legalName).trim();
    if (name.length < 2) out.push({ field: "legalName", level: "error", message: "The legal name is too short.", fix: "Type the full registered name." });
    if ((entity === "PRIVATE_PROFIT" || entity === "PUBLIC_PROFIT") && !LEGAL_SUFFIX.test(name)) {
      out.push({ field: "legalName", level: "warn", message: "Most registered companies end in LLC, Inc., Corp. or similar.", fix: "TCR matches this name to the EIN's IRS record letter for letter: copy it from the IRS letter, suffix included." });
    }
    if (!blank(b.dba) && name.toLowerCase() === String(b.dba).trim().toLowerCase() && LEGAL_SUFFIX.test(name)) {
      out.push({ field: "dba", level: "warn", message: "The brand name (DBA) is the same as the legal name.", fix: "The DBA is the name customers see in your texts; leave it empty if you have none." });
    }
  }
  out.push(...einProblems(b.ein, entity));
  if (entity === "PUBLIC_PROFIT" && (blank(b.stockSymbol) || blank(b.stockExchange))) out.push({ field: "stockSymbol", level: "error", message: "A public company needs its stock symbol and exchange.", fix: "Enter the ticker (e.g. ACME) and the exchange (NASDAQ, NYSE…)." });

  if (blank(b.vertical)) out.push({ field: "vertical", level: "error", message: "Pick the industry.", fix: "Choose the closest industry; it decides which carrier rules apply." });
  else if (!(VERTICALS as readonly string[]).includes(String(b.vertical))) out.push({ field: "vertical", level: "error", message: "That industry is not one TCR accepts.", fix: "Choose one from the list." });

  out.push(...websiteFormatProblems(b.website));

  if (blank(b.phone)) out.push({ field: "phone", level: "error", message: "A business phone number is required.", fix: "The main number customers reach the business on, ten digits." });
  else if (!normalizePhone(b.phone)) out.push({ field: "phone", level: "error", message: "That is not a valid US phone number.", fix: "Ten digits, like (305) 555-1234." });

  if (blank(b.supportEmail)) out.push({ field: "supportEmail", level: "error", message: "A support email is required.", fix: "An address customers can write to, ideally on your website's domain." });
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.supportEmail).trim())) out.push({ field: "supportEmail", level: "error", message: "That is not an email address.", fix: "Use the form name@yourbusiness.com." });
  else {
    const dom = String(b.supportEmail).trim().toLowerCase().split("@")[1]!;
    const site = domainOf(b.website);
    if (FREE_MAIL_DOMAINS.has(dom)) out.push({ field: "supportEmail", level: "warn", message: `A ${dom} address makes the brand harder to verify.`, fix: "Use an address on the business's own domain if you have one." });
    else if (site && dom !== site && !dom.endsWith(`.${site}`) && !site.endsWith(`.${dom}`)) out.push({ field: "supportEmail", level: "warn", message: `The email domain (${dom}) is not the website's (${site}).`, fix: "Carriers compare them; use an address at the website's domain if you can." });
  }

  out.push(...addressProblems(b));
  return out;
}

export function addressProblems(b: Pick<BrandFields, "street" | "city" | "state" | "zip" | "country">): Problem[] {
  const out: Problem[] = [];
  const country = (b.country || "US").toUpperCase();
  if (country !== "US") out.push({ field: "country", level: "error", message: "Only US businesses can register for US 10DLC here.", fix: "Use the business's US address." });
  if (blank(b.street)) out.push({ field: "street", level: "error", message: "The street address is required.", fix: "The registered business address, with the street number." });
  else {
    const s = String(b.street).trim();
    if (/\bp\.?\s*o\.?\s*box\b|\bpost office box\b/i.test(s)) out.push({ field: "street", level: "error", message: "A PO Box is not accepted.", fix: "Use the street address the business is registered at." });
    else if (!/\d/.test(s)) out.push({ field: "street", level: "warn", message: "The street address has no number.", fix: "Include the building number, e.g. 75 South Broadway." });
  }
  if (blank(b.city)) out.push({ field: "city", level: "error", message: "The city is required.", fix: "The city of the business address." });
  const st = String(b.state ?? "").trim().toUpperCase();
  if (!st) out.push({ field: "state", level: "error", message: "The state is required.", fix: "Two letters, e.g. NY." });
  else if (!US_STATES.has(st)) out.push({ field: "state", level: "error", message: `${st} is not a US state.`, fix: "Use the two-letter postal code, e.g. FL." });
  const zip = String(b.zip ?? "").trim();
  if (!zip) out.push({ field: "zip", level: "error", message: "The ZIP code is required.", fix: "Five digits (or ZIP+4)." });
  else if (!/^\d{5}(-?\d{4})?$/.test(zip)) out.push({ field: "zip", level: "error", message: "A ZIP code is five digits (or ZIP+4).", fix: "e.g. 10601 or 10601-1234." });
  else if (st && US_STATES.has(st)) {
    const zs = stateForZip(zip.slice(0, 5));
    if (zs && zs !== st) out.push({ field: "zip", level: "warn", message: `ZIP ${zip.slice(0, 5)} is in ${zs}, not ${st}.`, fix: "Check the state and ZIP: TCR verifies the address." });
  }
  return out;
}

// ─────────────────────────────── Website ───────────────────────────────

/** What the engine's fetch of the website found (and what `analyzeSite` read from the pages). */
export interface WebsiteFindings {
  url: string;
  checkedAt: string;
  reachable: boolean;
  status?: number;
  finalUrl?: string;
  https?: boolean;
  error?: string;
  /** The legal name or the DBA appears on the home page. Null when not checked. */
  showsName: boolean | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  privacyReachable?: boolean | null;
  /** The privacy policy says mobile numbers / SMS consent are not shared or sold (a CTIA requirement). */
  privacyNoSharing: boolean | null;
  /** The site carries SMS consent wording (message frequency, rates, STOP). */
  smsDisclosure: boolean | null;
  /** The page says it is under construction / parked / for sale. */
  placeholder?: boolean;
}

const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A business name with its legal suffix and punctuation removed, for matching on a page. */
export function nameCore(name: string): string {
  return norm(name)
    .replace(/\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|llp|lp|pc|pa|pllc|plc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every link on a page as [absolute href, link text]. */
export function pageLinks(html: string, base: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      out.push([new URL(m[1]!, base).toString(), text(m[2]!)]);
    } catch {
      /* skip */
    }
  }
  return out;
}

const PRIVACY_LINK = /privacy/i;
const TERMS_LINK = /\bterms\b|terms[-_ ]?(of|and|&)|conditions|\btos\b/i;

/** Read the home page: does it show the business name, link a privacy policy and terms, carry SMS consent wording? */
export function analyzeSite(html: string, base: string, names: string[]): Pick<WebsiteFindings, "showsName" | "privacyUrl" | "termsUrl" | "smsDisclosure" | "placeholder"> {
  const body = norm(text(html));
  const title = norm(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const cores = names.map(nameCore).filter((n) => n.length >= 3);
  const showsName = cores.length ? cores.some((c) => body.includes(c) || title.includes(c)) : null;
  const links = pageLinks(html, base);
  const privacyUrl = links.find(([h, t]) => PRIVACY_LINK.test(t) || PRIVACY_LINK.test(h))?.[0] ?? null;
  const termsUrl = links.find(([h, t]) => (TERMS_LINK.test(t) || /terms|conditions|tos/i.test(new URL(h).pathname)) && !PRIVACY_LINK.test(t))?.[0] ?? null;
  return { showsName, privacyUrl, termsUrl, smsDisclosure: smsDisclosureIn(body), placeholder: /\b(under construction|coming soon|domain (is )?for sale|this domain (may be|is) for sale|parked free|website is (being )?built)\b/.test(body) };
}

/** SMS consent wording on a page: frequency, "msg and data rates", and STOP. */
export function smsDisclosureIn(normalisedText: string): boolean {
  const t = normalisedText;
  return /\b(text|sms|messag)/.test(t) && /\bstop\b/.test(t) && /(data rates|msg and data|message and data)/.test(t);
}

/** CTIA: the privacy policy must say mobile information / SMS opt-in data is not shared with or sold to third parties. */
export function privacyNoSharingIn(html: string): boolean {
  const t = norm(text(html));
  const mentionsMobile = /\b(mobile|sms|text messag|phone number|opt in|originator opt in)/.test(t);
  const notShared = /(will not|won t|do not|don t|does not|never|shall not|not be) (be )?(share|sold|sell|rent|transfer|disclose)/.test(t) || /no mobile information will be shared/.test(t) || /(not|never) (be )?(shared|sold|rented) (with|to) (any )?third part/.test(t);
  return mentionsMobile && notShared;
}

/** The website findings as problems against the `website` field. */
export function websiteProblems(f: WebsiteFindings | null | undefined): Problem[] {
  if (!f) return [];
  if (!f.reachable) return [{ field: "website", level: "error", message: `The website did not open${f.status ? ` (HTTP ${f.status})` : f.error ? ` (${f.error})` : ""}.`, fix: "Carriers visit it during review: make sure it loads for anyone, without a password or a VPN." }];
  const out: Problem[] = [];
  if (f.placeholder) out.push({ field: "website", level: "error", message: "The website looks like a placeholder (under construction, coming soon or parked).", fix: "Publish the real site before submitting: a placeholder is rejected." });
  if (f.https === false) out.push({ field: "website", level: "warn", message: "The website does not load over https.", fix: "Add a certificate (most hosts do it for free)." });
  if (f.showsName === false) out.push({ field: "website", level: "error", message: "The home page does not show the business name.", fix: "Carriers match the site to the brand: show the legal name or the DBA on the home page (the footer is enough)." });
  if (!f.privacyUrl) out.push({ field: "website", level: "error", message: "No privacy policy link on the home page.", fix: "Add a Privacy Policy page and link it from every page (the footer is the usual place)." });
  else if (f.privacyReachable === false) out.push({ field: "website", level: "error", message: "The privacy policy link does not open.", fix: `Fix the page at ${f.privacyUrl}.` });
  else if (f.privacyNoSharing === false)
    out.push({ field: "website", level: "error", message: "The privacy policy does not say mobile numbers are not shared.", fix: 'Add this sentence: "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties."' });
  if (!f.termsUrl) out.push({ field: "website", level: "error", message: "No terms and conditions link on the home page.", fix: "Add a Terms page (with your SMS program terms: what you send, how often, STOP/HELP, rates) and link it in the footer." });
  if (f.smsDisclosure === false) out.push({ field: "website", level: "warn", message: "The home page has no texting consent wording.", fix: "Where people give their number, add: \"By submitting, you agree to receive calls and texts from <brand>. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.\"" });
  return out;
}

// ─────────────────────────────── Campaign ───────────────────────────────

export interface CampaignFields {
  usecase?: string;
  description?: string;
  samples?: string[];
  optInMethod?: string;
  /** The consent wording people see (or hear) when they give their number. */
  optInWording?: string;
  /** Where the opt-in happens (the page with the form), when it is a web form. */
  optInUrl?: string;
  optInMessage?: string;
  optOutKeywords?: string;
  optOutMessage?: string;
  helpKeywords?: string;
  helpMessage?: string;
  /** Messages a month, estimated. */
  monthlyVolume?: number | string;
  embeddedLink?: boolean;
  embeddedPhone?: boolean;
  directLending?: boolean;
  ageGated?: boolean;
  numberPool?: boolean;
  privacyUrl?: string;
  termsUrl?: string;
}

/** Compliant default replies for a brand (prefilled in the wizard; the person may edit them). */
export function defaultReplies(brand: string, contact: string | null) {
  const b = brand.trim() || "Our team";
  const help = contact ? ` or contact ${contact}` : "";
  return {
    optInMessage: `${b}: You are opted in to texts about your request. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    optOutMessage: `${b}: You are unsubscribed and will receive no more messages. Reply START to resubscribe.`,
    helpMessage: `${b}: For help reply here${help}. Msg & data rates may apply. Reply STOP to opt out.`,
    optOutKeywords: OPT_OUT_KEYWORDS,
    helpKeywords: HELP_KEYWORDS,
  };
}

/** Consent wording for a web form, prefilled. */
export function defaultOptInWording(brand: string): string {
  const b = brand.trim() || "us";
  return `By submitting this form, I agree to receive calls and text messages from ${b} at the number provided about my request, including by automated means. Consent is not a condition of purchase. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms.`;
}

const hasLink = (s: string) => /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|us|info|biz|digital)\b(\/|\s|$)/i.test(s);
const hasPhone = (s: string) => /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(s);
const keywordsOf = (s: string | undefined) =>
  String(s ?? "")
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean);

/** The message-flow text TCR asks for, built from the opt-in method, the wording and the page. */
export function messageFlowText(c: CampaignFields): string {
  const wording = String(c.optInWording ?? "").trim();
  const where = String(c.optInUrl ?? "").trim();
  const how: Record<string, string> = {
    WEB_FORM: `Consumers opt in by submitting the web form${where ? ` at ${where}` : " on our website"}, which shows this consent language next to the phone field`,
    VERBAL: "Consumers opt in verbally on a recorded call when our agent reads this consent language and they agree",
    KEYWORD: "Consumers opt in by texting our keyword to our number; the reply confirms the program",
    PAPER: "Consumers opt in by signing a paper form that carries this consent language",
  };
  const lead = how[String(c.optInMethod ?? "WEB_FORM")] ?? how.WEB_FORM!;
  const links = [c.privacyUrl ? `Privacy policy: ${c.privacyUrl}` : "", c.termsUrl ? `Terms: ${c.termsUrl}` : ""].filter(Boolean).join(". ");
  return `${lead}${wording ? `: "${wording}"` : ""}. They can reply STOP at any time to opt out and HELP for help.${links ? ` ${links}.` : ""}`;
}

/** Checks on a campaign as typed. `brandName` is what the texts must identify (DBA, else legal name). */
export function validateCampaign(c: CampaignFields, brandName: string): Problem[] {
  const out: Problem[] = [];
  const brand = nameCore(brandName);
  const mentions = (s: string) => (brand.length >= 3 ? norm(s).includes(brand) : true);
  if (blank(c.usecase)) out.push({ field: "usecase", level: "error", message: "Pick what the texts are for.", fix: "Low volume mixed fits most contact centers under 2,000 texts a day." });
  else if (!USECASES.some(([k]) => k === c.usecase)) out.push({ field: "usecase", level: "error", message: "That use case is not offered here.", fix: "Choose one from the list." });

  const d = String(c.description ?? "").trim();
  if (d.length < 40) out.push({ field: "description", level: "error", message: "Describe the texts in a sentence or two (40 characters or more).", fix: "Say who sends them, to whom and why, e.g. \"Acme texts people who asked for a quote: a heads-up before we call and replies from our agents.\"" });
  else if (!mentions(d)) out.push({ field: "description", level: "warn", message: "The description does not name the business.", fix: `Start it with "${brandName || "the business name"} texts…".` });

  const samples = (c.samples ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (samples.length < 2) out.push({ field: "samples", level: "error", message: "At least two sample messages are required.", fix: "Write two texts exactly as you would send them." });
  samples.forEach((s, i) => {
    const f = `sample${i + 1}`;
    if (s.length < 20) out.push({ field: f, level: "error", message: `Sample ${i + 1} is too short.`, fix: "Write the whole message, 20 characters or more." });
    if (s.length > 1024) out.push({ field: f, level: "error", message: `Sample ${i + 1} is longer than 1,024 characters.`, fix: "Shorten it." });
    if (!mentions(s)) out.push({ field: f, level: "error", message: `Sample ${i + 1} does not name the business.`, fix: `Carriers require every text to identify the sender: include "${brandName || "your business name"}".` });
    if (hasLink(s) && c.embeddedLink === false) out.push({ field: f, level: "error", message: `Sample ${i + 1} has a link but "messages contain links" is off.`, fix: "Tick it, or take the link out." });
    if (hasPhone(s) && c.embeddedPhone === false) out.push({ field: f, level: "error", message: `Sample ${i + 1} has a phone number but "messages contain phone numbers" is off.`, fix: "Tick it, or take the number out." });
    if (/\b(bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly|is\.gd)\b/i.test(s)) out.push({ field: f, level: "error", message: `Sample ${i + 1} uses a public link shortener.`, fix: "Carriers block shared shorteners: use your own domain's full link." });
  });
  if (samples.length && !samples.some((s) => /\bstop\b/i.test(s))) out.push({ field: "samples", level: "warn", message: "No sample tells people how to opt out.", fix: 'Add "Reply STOP to opt out" to the first message you send someone.' });
  if (samples.some(hasLink) && c.embeddedLink === undefined) out.push({ field: "embeddedLink", level: "warn", message: "Your samples contain links.", fix: 'Tick "messages contain links".' });

  const method = String(c.optInMethod ?? "");
  if (!method) out.push({ field: "optInMethod", level: "error", message: "Say how people agree to get texts.", fix: "Most contact centers: a form on the website." });
  const w = String(c.optInWording ?? "").trim();
  if (w.length < 40) out.push({ field: "optInWording", level: "error", message: "The consent wording people agree to is required.", fix: "Paste the sentence next to the phone field on your form (a compliant default is offered)." });
  else {
    const n = norm(w);
    if (!mentions(w)) out.push({ field: "optInWording", level: "error", message: "The consent wording does not name the business.", fix: "Consent must be to this business by name." });
    if (!/\b(text|sms|messag)/.test(n)) out.push({ field: "optInWording", level: "error", message: "The consent wording does not mention text messages.", fix: 'Say "calls and text messages".' });
    if (!/\bstop\b/.test(n)) out.push({ field: "optInWording", level: "error", message: "The consent wording does not say how to opt out.", fix: 'Add "Reply STOP to opt out".' });
    if (!/(data rates|msg and data|message and data)/.test(n)) out.push({ field: "optInWording", level: "warn", message: 'The consent wording does not say "Msg & data rates may apply".', fix: "Add it: carriers check for it." });
    if (!/(frequency|recurring|messages per|msgs per|varies)/.test(n)) out.push({ field: "optInWording", level: "warn", message: "The consent wording does not give the message frequency.", fix: 'Add "Msg frequency varies."' });
    if (!/\bhelp\b/.test(n)) out.push({ field: "optInWording", level: "warn", message: "The consent wording does not mention HELP.", fix: 'Add "Reply HELP for help."' });
  }
  if (method === "WEB_FORM" && !blank(c.optInUrl) && !normalizeWebsite(c.optInUrl)) out.push({ field: "optInUrl", level: "error", message: "The form page address is not a web address.", fix: "Paste the full link of the page with the form." });
  if (method === "WEB_FORM" && blank(c.optInUrl)) out.push({ field: "optInUrl", level: "warn", message: "No link to the page with the opt-in form.", fix: "Carriers look for the form: give the page address (the home page if the form is there)." });

  const outKw = keywordsOf(c.optOutKeywords);
  if (!outKw.includes("STOP")) out.push({ field: "optOutKeywords", level: "error", message: "STOP must be an opt-out keyword.", fix: `Use ${OPT_OUT_KEYWORDS}.` });
  if (!keywordsOf(c.helpKeywords).includes("HELP")) out.push({ field: "helpKeywords", level: "error", message: "HELP must be a help keyword.", fix: `Use ${HELP_KEYWORDS}.` });
  const om = String(c.optOutMessage ?? "").trim();
  if (!om) out.push({ field: "optOutMessage", level: "error", message: "The reply to STOP is required.", fix: "Confirm they will get no more messages." });
  else {
    if (!mentions(om)) out.push({ field: "optOutMessage", level: "error", message: "The STOP reply does not name the business.", fix: "Start it with the business name." });
    if (!/(no (more|further)|unsubscribed|opted out|will not receive|won't receive)/i.test(om)) out.push({ field: "optOutMessage", level: "error", message: "The STOP reply does not confirm they are opted out.", fix: 'Say "You are unsubscribed and will receive no more messages."' });
  }
  const hm = String(c.helpMessage ?? "").trim();
  if (!hm) out.push({ field: "helpMessage", level: "error", message: "The reply to HELP is required.", fix: "Name the business and give a way to reach you." });
  else {
    if (!mentions(hm)) out.push({ field: "helpMessage", level: "error", message: "The HELP reply does not name the business.", fix: "Start it with the business name." });
    if (!hasPhone(hm) && !/@/.test(hm) && !hasLink(hm) && !/reply here/i.test(hm)) out.push({ field: "helpMessage", level: "warn", message: "The HELP reply gives no way to reach you.", fix: "Add a phone number or the support email." });
    if (!/\bstop\b/i.test(hm)) out.push({ field: "helpMessage", level: "warn", message: "The HELP reply does not say how to opt out.", fix: 'Add "Reply STOP to opt out."' });
  }
  const im = String(c.optInMessage ?? "").trim();
  if (im && !mentions(im)) out.push({ field: "optInMessage", level: "warn", message: "The opt-in confirmation does not name the business.", fix: "Start it with the business name." });

  if (blank(c.privacyUrl)) out.push({ field: "privacyUrl", level: "error", message: "The privacy policy link is required.", fix: "The page on your site (the website check finds it for you)." });
  else if (!normalizeWebsite(c.privacyUrl)) out.push({ field: "privacyUrl", level: "error", message: "The privacy policy link is not a web address.", fix: "Paste the full link." });
  if (blank(c.termsUrl)) out.push({ field: "termsUrl", level: "error", message: "The terms link is required.", fix: "The page on your site (the website check finds it for you)." });
  else if (!normalizeWebsite(c.termsUrl)) out.push({ field: "termsUrl", level: "error", message: "The terms link is not a web address.", fix: "Paste the full link." });

  const vol = Number(c.monthlyVolume ?? 0);
  if (!vol) out.push({ field: "monthlyVolume", level: "warn", message: "No estimate of messages a month.", fix: "A rough number decides whether the low-volume use case fits." });
  else if (c.usecase === "LOW_VOLUME" && vol / 30 > LOW_VOLUME_DAILY_MAX) out.push({ field: "usecase", level: "error", message: `About ${Math.round(vol / 30).toLocaleString()} texts a day is over the low-volume limit of ${LOW_VOLUME_DAILY_MAX.toLocaleString()}.`, fix: "Pick Mixed or Marketing instead." });
  if (/\b(loans?|lending|lenders?|mortgages?|cash advances?|payday|credit repair|debt (relief|consolidation|settlement))\b/i.test(`${d} ${samples.join(" ")}`) && !c.directLending) {
    out.push({ field: "directLending", level: "warn", message: "The texts mention loans or debt.", fix: 'Tick "lending / loans": carriers vet these separately and reject them unflagged.' });
  }
  return out;
}

/** Errors only: anything left blocks submission. */
export const blocking = (ps: Problem[]) => ps.filter((p) => p.level === "error");

/** The checklist the wizard shows under "Ready for 10DLC". */
export function readyChecklist(b: BrandFields, site: WebsiteFindings | null, c: CampaignFields | null): { label: string; ok: boolean; detail?: string }[] {
  const bp = validateBrand(b);
  const has = (fields: string[]) => !bp.some((p) => p.level === "error" && fields.includes(p.field));
  const rows = [
    { label: "Legal name and entity type", ok: has(["legalName", "entityType", "firstName"]) },
    { label: "EIN", ok: has(["ein"]) },
    { label: "Industry", ok: has(["vertical"]) },
    { label: "Full street address (no PO Box)", ok: has(["street", "city", "state", "zip", "country"]) },
    { label: "Business phone and support email", ok: has(["phone", "supportEmail"]) },
    { label: "Website opens and shows the business name", ok: Boolean(site?.reachable) && site?.showsName !== false && !site?.placeholder && has(["website"]), detail: site ? undefined : "not checked yet" },
    { label: "Privacy policy (says mobile numbers are not shared)", ok: Boolean(site?.privacyUrl) && site?.privacyNoSharing !== false && site?.privacyReachable !== false },
    { label: "Terms and conditions page", ok: Boolean(site?.termsUrl) },
  ];
  if (c) {
    const cp = blocking(validateCampaign(c, b.dba || b.legalName || ""));
    rows.push({ label: "Texting campaign: use case, description, 2+ samples, opt-in, STOP/HELP replies", ok: cp.length === 0 });
  }
  return rows;
}

/** The brand as Telnyx's `POST /10dlc/brand` takes it (`BrandInput` in the engine). */
export function toBrandInput(b: BrandFields, contactEmail: string) {
  const entity = (b.entityType || "PRIVATE_PROFIT") as EntityType;
  const sole = entity === "SOLE_PROPRIETOR";
  const phone = normalizePhone(b.phone);
  return {
    entityType: entity,
    displayName: (b.dba || b.legalName || `${b.firstName ?? ""} ${b.lastName ?? ""}`).trim(),
    companyName: sole ? undefined : String(b.legalName ?? "").trim(),
    firstName: sole ? String(b.firstName ?? "").trim() : undefined,
    lastName: sole ? String(b.lastName ?? "").trim() : undefined,
    ein: sole ? undefined : (formatEin(b.ein) ?? undefined),
    phone: phone ? `+1${phone}` : undefined,
    street: String(b.street ?? "").trim(),
    city: String(b.city ?? "").trim(),
    state: String(b.state ?? "").trim().toUpperCase(),
    postalCode: String(b.zip ?? "").trim(),
    country: "US",
    email: String(b.supportEmail ?? contactEmail).trim(),
    website: normalizeWebsite(b.website) ?? undefined,
    vertical: String(b.vertical ?? ""),
    stockSymbol: entity === "PUBLIC_PROFIT" ? b.stockSymbol : undefined,
    stockExchange: entity === "PUBLIC_PROFIT" ? b.stockExchange : undefined,
    businessContactEmail: contactEmail,
  };
}

/** The campaign as Telnyx's `POST /10dlc/campaignBuilder` takes it, less the brand id. */
export function toCampaignInput(c: CampaignFields) {
  const samples = (c.samples ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  return {
    usecase: String(c.usecase ?? "LOW_VOLUME"),
    description: String(c.description ?? "").trim(),
    messageFlow: messageFlowText(c),
    sample1: samples[0] ?? "",
    sample2: samples[1],
    sample3: samples[2],
    sample4: samples[3],
    sample5: samples[4],
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    optinKeywords: OPT_IN_KEYWORDS,
    optoutKeywords: keywordsOf(c.optOutKeywords).join(",") || OPT_OUT_KEYWORDS,
    helpKeywords: keywordsOf(c.helpKeywords).join(",") || HELP_KEYWORDS,
    optinMessage: String(c.optInMessage ?? "").trim() || undefined,
    optoutMessage: String(c.optOutMessage ?? "").trim(),
    helpMessage: String(c.helpMessage ?? "").trim(),
    embeddedLink: Boolean(c.embeddedLink ?? samples.some(hasLink)),
    embeddedPhone: Boolean(c.embeddedPhone ?? samples.some(hasPhone)),
    numberPool: Boolean(c.numberPool),
    ageGated: Boolean(c.ageGated),
    directLending: Boolean(c.directLending),
    autoRenewal: true,
    termsAndConditions: true,
    privacyPolicyLink: normalizeWebsite(c.privacyUrl) ?? undefined,
    termsAndConditionsLink: normalizeWebsite(c.termsUrl) ?? undefined,
    embeddedLinkSample: samples.map((s) => /https?:\/\/\S+/.exec(s)?.[0]).find(Boolean),
  };
}

/** A brand or campaign status from Telnyx, in three words a client understands. */
export function registrationTone(status: string | undefined | null): "pending" | "approved" | "rejected" | "none" {
  if (!status) return "none";
  if (/PROVISIONED|ACCEPTED|VERIFIED|ACTIVE|^OK$|APPROVED/i.test(status) && !/UNVERIFIED/i.test(status)) return "approved";
  if (/FAIL|REJECT|SUSPEND|EXPIRED|DECLINED|UNVERIFIED/i.test(status)) return "rejected";
  return "pending";
}
