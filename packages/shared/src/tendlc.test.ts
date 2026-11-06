import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeSite,
  blocking,
  defaultOptInWording,
  defaultReplies,
  einProblems,
  formatEin,
  messageFlowText,
  nameCore,
  normalizeWebsite,
  privacyNoSharingIn,
  readyChecklist,
  registrationTone,
  toBrandInput,
  toCampaignInput,
  validateBrand,
  validateCampaign,
  websiteProblems,
  type BrandFields,
  type CampaignFields,
  type WebsiteFindings,
} from "./tendlc";

const good: BrandFields = {
  entityType: "PRIVATE_PROFIT",
  legalName: "National Solar Resolutions LLC",
  dba: "National Solar",
  ein: "13-4567890",
  vertical: "ENERGY",
  website: "https://nationalsolarresolutions.com",
  phone: "(833) 677-0003",
  supportEmail: "help@nationalsolarresolutions.com",
  street: "75 South Broadway, 4th Floor",
  city: "White Plains",
  state: "NY",
  zip: "10601",
  country: "US",
};
const fields = (ps: { field: string }[]) => ps.map((p) => p.field);

test("a complete brand has no blocking problems", () => {
  assert.deepEqual(blocking(validateBrand(good)), []);
});

test("EIN: nine digits, a real prefix, not a placeholder; sole proprietors have none", () => {
  assert.equal(formatEin("134567890"), "13-4567890");
  assert.equal(formatEin("13-45678"), null);
  assert.equal(einProblems("13-4567890", "PRIVATE_PROFIT").length, 0);
  assert.equal(einProblems("", "PRIVATE_PROFIT")[0]?.level, "error");
  assert.match(einProblems("12-345", "PRIVATE_PROFIT")[0]!.message, /nine digits/);
  assert.match(einProblems("07-1234567", "PRIVATE_PROFIT")[0]!.message, /No EIN starts with 07/);
  assert.match(einProblems("12-3456789", "NON_PROFIT")[0]!.message, /placeholder/);
  assert.equal(einProblems("", "SOLE_PROPRIETOR").length, 0);
  assert.equal(einProblems("13-4567890", "SOLE_PROPRIETOR")[0]?.level, "warn");
});

test("address: PO boxes refused, state and ZIP checked against each other", () => {
  assert.ok(fields(blocking(validateBrand({ ...good, street: "PO Box 12" }))).includes("street"));
  assert.ok(fields(blocking(validateBrand({ ...good, state: "ZZ" }))).includes("state"));
  assert.ok(fields(blocking(validateBrand({ ...good, zip: "1060" }))).includes("zip"));
  const wrongState = validateBrand({ ...good, state: "FL" }).find((p) => p.field === "zip");
  assert.equal(wrongState?.level, "warn");
  assert.match(wrongState!.message, /10601 is in NY, not FL/);
  assert.ok(fields(blocking(validateBrand({ ...good, city: "" }))).includes("city"));
});

test("legal name: required, suffix expected for companies, DBA the same is flagged", () => {
  assert.ok(fields(blocking(validateBrand({ ...good, legalName: "" }))).includes("legalName"));
  assert.equal(validateBrand({ ...good, legalName: "National Solar Resolutions" }).find((p) => p.field === "legalName")?.level, "warn");
  assert.equal(validateBrand({ ...good, dba: "national solar resolutions llc" }).find((p) => p.field === "dba")?.level, "warn");
  const sole = validateBrand({ ...good, entityType: "SOLE_PROPRIETOR", legalName: "", ein: "" });
  assert.ok(fields(blocking(sole)).includes("firstName"));
  assert.deepEqual(blocking(validateBrand({ ...good, entityType: "SOLE_PROPRIETOR", ein: "", firstName: "Ann", lastName: "Lee" })), []);
});

test("website, phone and email formats", () => {
  assert.ok(fields(blocking(validateBrand({ ...good, website: "" }))).includes("website"));
  assert.ok(fields(blocking(validateBrand({ ...good, website: "https://facebook.com/acme" }))).includes("website"));
  assert.equal(validateBrand({ ...good, website: "http://nationalsolarresolutions.com" }).find((p) => p.field === "website")?.level, "warn");
  assert.ok(fields(blocking(validateBrand({ ...good, phone: "555-12" }))).includes("phone"));
  assert.ok(fields(blocking(validateBrand({ ...good, supportEmail: "nope" }))).includes("supportEmail"));
  assert.equal(validateBrand({ ...good, supportEmail: "acme@gmail.com" }).find((p) => p.field === "supportEmail")?.level, "warn");
  assert.match(validateBrand({ ...good, supportEmail: "a@other.com" }).find((p) => p.field === "supportEmail")!.message, /not the website's/);
  assert.equal(normalizeWebsite("acme.com"), "https://acme.com/");
  assert.equal(normalizeWebsite("localhost"), null);
});

const home = `<html><head><title>National Solar | Home</title></head><body>
<h1>Go solar with National Solar</h1>
<form>Phone <input name=phone> By submitting you agree to receive calls and text messages. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out.</form>
<footer>&copy; National Solar Resolutions LLC · <a href="/privacy-policy">Privacy Policy</a> · <a href="https://nationalsolarresolutions.com/terms">Terms of Service</a></footer>
</body></html>`;

test("the website check reads the name, the privacy and terms links and the SMS wording", () => {
  const a = analyzeSite(home, "https://nationalsolarresolutions.com/", [good.legalName!, good.dba!]);
  assert.equal(a.showsName, true);
  assert.equal(a.privacyUrl, "https://nationalsolarresolutions.com/privacy-policy");
  assert.equal(a.termsUrl, "https://nationalsolarresolutions.com/terms");
  assert.equal(a.smsDisclosure, true);
  assert.equal(a.placeholder, false);
  const bare = analyzeSite("<html><body><h1>Coming soon</h1></body></html>", "https://x.com/", ["Acme Roofing LLC"]);
  assert.equal(bare.showsName, false);
  assert.equal(bare.privacyUrl, null);
  assert.equal(bare.termsUrl, null);
  assert.equal(bare.placeholder, true);
  assert.equal(nameCore("Acme Roofing, L.L.C."), "acme roofing");
});

test("privacy policy must say mobile information is not shared", () => {
  assert.equal(privacyNoSharingIn("<p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</p>"), true);
  assert.equal(privacyNoSharingIn("<p>We do not sell your phone number to anyone.</p>"), true);
  assert.equal(privacyNoSharingIn("<p>We may share your information with partners.</p>"), false);
});

test("website findings become problems with fixes", () => {
  const base: WebsiteFindings = { url: "https://x.com", checkedAt: "", reachable: true, https: true, showsName: true, privacyUrl: "https://x.com/p", termsUrl: "https://x.com/t", privacyReachable: true, privacyNoSharing: true, smsDisclosure: true };
  assert.deepEqual(websiteProblems(base), []);
  assert.match(websiteProblems({ ...base, reachable: false, status: 503 })[0]!.message, /HTTP 503/);
  assert.equal(websiteProblems({ ...base, showsName: false })[0]!.level, "error");
  assert.match(websiteProblems({ ...base, privacyNoSharing: false })[0]!.fix, /No mobile information will be shared/);
  assert.equal(websiteProblems({ ...base, termsUrl: null }).length, 1);
  assert.equal(websiteProblems({ ...base, smsDisclosure: false })[0]!.level, "warn");
  assert.deepEqual(websiteProblems(null), []);
});

const campaign = (): CampaignFields => ({
  usecase: "LOW_VOLUME",
  description: "National Solar texts homeowners who asked for a solar quote: a heads-up before we call and replies from our agents.",
  samples: [
    "Hi Jane, this is National Solar. Your phone will ring in a minute from (305) 555-1234 about your quote. Reply STOP to opt out.",
    "National Solar: sorry we missed you! Pick a callback time at https://nationalsolarresolutions.com/cb Reply STOP to opt out.",
  ],
  optInMethod: "WEB_FORM",
  optInWording: defaultOptInWording("National Solar"),
  optInUrl: "https://nationalsolarresolutions.com",
  ...defaultReplies("National Solar", "help@nationalsolarresolutions.com"),
  monthlyVolume: 5000,
  embeddedLink: true,
  embeddedPhone: true,
  privacyUrl: "https://nationalsolarresolutions.com/privacy-policy",
  termsUrl: "https://nationalsolarresolutions.com/terms",
});

test("the prefilled defaults pass the campaign checks", () => {
  assert.deepEqual(validateCampaign(campaign(), "National Solar"), []);
});

test("campaign: two samples naming the brand, links and phones declared, no shorteners", () => {
  const one = { ...campaign(), samples: [campaign().samples![0]!] };
  assert.ok(fields(blocking(validateCampaign(one, "National Solar"))).includes("samples"));
  const anon = { ...campaign(), samples: ["Hi Jane, your quote is ready, call us back. Reply STOP to opt out.", campaign().samples![1]!] };
  assert.ok(fields(blocking(validateCampaign(anon, "National Solar"))).includes("sample1"));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), embeddedLink: false }, "National Solar"))).includes("sample2"));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), embeddedPhone: false }, "National Solar"))).includes("sample1"));
  const short = { ...campaign(), samples: [campaign().samples![0]!, "National Solar: your quote https://bit.ly/abc Reply STOP to opt out."] };
  assert.match(blocking(validateCampaign(short, "National Solar")).find((p) => p.field === "sample2")!.message, /shortener/);
});

test("campaign: opt-in wording, STOP/HELP replies, links and volume", () => {
  const w = validateCampaign({ ...campaign(), optInWording: "By submitting you agree to hear from National Solar by phone at any time." }, "National Solar");
  assert.ok(blocking(w).some((p) => p.field === "optInWording" && /text messages/.test(p.message)));
  assert.ok(blocking(w).some((p) => p.field === "optInWording" && /opt out/.test(p.message)));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), optOutKeywords: "END" }, "National Solar"))).includes("optOutKeywords"));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), optOutMessage: "Bye" }, "National Solar"))).includes("optOutMessage"));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), privacyUrl: "" }, "National Solar"))).includes("privacyUrl"));
  assert.ok(fields(blocking(validateCampaign({ ...campaign(), monthlyVolume: 90000 }, "National Solar"))).includes("usecase"));
  const loans = validateCampaign({ ...campaign(), description: "National Solar texts homeowners about solar loans and financing options for their roof." }, "National Solar");
  assert.equal(loans.find((p) => p.field === "directLending")?.level, "warn");
});

test("message flow and the Telnyx shapes", () => {
  const c = campaign();
  assert.match(messageFlowText(c), /^Consumers opt in by submitting the web form at https:\/\/nationalsolarresolutions.com/);
  assert.match(messageFlowText(c), /Privacy policy: https:\/\/nationalsolarresolutions.com\/privacy-policy/);
  const ci = toCampaignInput(c);
  assert.equal(ci.sample2, c.samples![1]);
  assert.equal(ci.optoutKeywords, "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT");
  assert.equal(ci.embeddedLinkSample, "https://nationalsolarresolutions.com/cb");
  const bi = toBrandInput(good, "owner@nationalsolarresolutions.com");
  assert.equal(bi.displayName, "National Solar");
  assert.equal(bi.companyName, "National Solar Resolutions LLC");
  assert.equal(bi.ein, "13-4567890");
  assert.equal(bi.phone, "+18336770003");
  assert.equal(bi.postalCode, "10601");
  assert.equal(bi.website, "https://nationalsolarresolutions.com/");
});

test("ready checklist and registration tone", () => {
  const site: WebsiteFindings = { url: "", checkedAt: "", reachable: true, https: true, showsName: true, privacyUrl: "p", termsUrl: "t", privacyReachable: true, privacyNoSharing: true, smsDisclosure: true };
  assert.ok(readyChecklist(good, site, campaign()).every((r) => r.ok));
  const rows = readyChecklist({ ...good, ein: "" }, null, null);
  assert.equal(rows.find((r) => r.label === "EIN")?.ok, false);
  assert.equal(rows.find((r) => r.label.startsWith("Website"))?.ok, false);
  assert.equal(registrationTone("MNO_PROVISIONED"), "approved");
  assert.equal(registrationTone("TCR_PENDING"), "pending");
  assert.equal(registrationTone("UNVERIFIED"), "rejected");
  assert.equal(registrationTone("MNO_REJECTED"), "rejected");
  assert.equal(registrationTone(null), "none");
});
