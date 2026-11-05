import assert from "node:assert/strict";
import { test } from "node:test";
import { FieldError, formatDestination, fromRecord, parseCampaignSettings, parseDialPlan, parseDisposition, parseRebuttals, parseTransferDestination, parseWebhook, rebuttalsText, scriptBody } from "./campaign-form";
import { CAMPAIGN_TABS, SETTING_TAB, campaignTab, dirtyTabs, rebaseDraft, removedIds, type CampaignDraft } from "./campaign-draft";
import { CAMPAIGN_SETTING_KEYS } from "./campaign-form";
import { betTopUps, clampBetSettings } from "./games";

const before = { name: "Solar", status: "DRAFT", dialMode: "PREVIEW", voicemailAction: "HANGUP", voicemailMode: "FILE", screenerAction: "MESSAGE", callerIdMode: "LOCAL_PRESENCE", hopperOrder: "LIFO", listSelection: "STRICT_PRIORITY" };

test("campaign settings keep the page's clamps", () => {
  const s = parseCampaignSettings(
    fromRecord({ name: "  ", ratio: "0.5", maxRatio: "0.2", maxAttemptsPerDay: "40", abandonCapPct: "9", abandonWarnPct: "0", abandonTimerMs: "100", localWindowStart: "-3", localWindowEnd: "30", voicemailRetryMinutes: "1", wrapUpSeconds: "-1", callbackOwnerMinutes: "-5", fixedCallerId: "+1 (305) 555-0100", recordingOn: true, amdEnabled: false, voicemailScript: "  ", screenerScript: " hi " }),
    before,
  );
  assert.equal(s.name, "Solar");
  assert.equal(s.ratio, 1);
  assert.equal(s.maxRatio, 1);
  assert.equal(s.maxAttemptsPerDay, 10);
  assert.equal(s.abandonCapPct, 3);
  assert.equal(s.abandonWarnPct, 0.5);
  assert.equal(s.abandonTimerMs, 500);
  assert.equal(s.localWindowStart, 0);
  assert.equal(s.localWindowEnd, 24);
  assert.equal(s.voicemailRetryMinutes, 15);
  assert.equal(s.wrapUpSeconds, 0);
  assert.equal(s.callbackOwnerMinutes, 0);
  assert.equal(s.fixedCallerId, "3055550100");
  assert.equal(s.recordingOn, true);
  assert.equal(s.amdEnabled, false);
  assert.equal(s.voicemailScript, null);
  assert.equal(s.screenerScript, "hi");
  // Enums fall back to the stored value only when absent.
  assert.equal(s.status, "DRAFT");
  assert.equal(parseCampaignSettings(fromRecord({ status: "ACTIVE" }), before).status, "ACTIVE");
});

test("every campaign setting sits on exactly one tab", () => {
  for (const k of CAMPAIGN_SETTING_KEYS) assert.ok(CAMPAIGN_TABS.some((t) => t.key === SETTING_TAB[k]), k);
  assert.equal(Object.keys(SETTING_TAB).length, CAMPAIGN_SETTING_KEYS.length);
});

test("dial plans: empty To is open-ended, attempts 1..10, gap at least 5", () => {
  const p = parseDialPlan(fromRecord({ leadType: " ", ageFromDays: "-1", ageToDays: "", attemptsPerDay: "12", retryGapMinutes: "1", weight: "7" }));
  assert.deepEqual(p, { leadType: null, ageFromDays: 0, ageToDays: null, attemptsPerDay: 10, retryGapMinutes: 5, weight: 7, active: true });
});

test("dispositions: code cleaned, code and label required, empty recycle is final", () => {
  const d = parseDisposition(fromRecord({ code: " sale-ok! ", label: " Sale ", hotkey: "12", isSale: true, recycleAfterMinutes: "" }));
  assert.equal(d.code, "SALEOK");
  assert.equal(d.hotkey, "1");
  assert.equal(d.recycleAfterMinutes, null);
  assert.equal(parseDisposition(fromRecord({ code: "NA", label: "x", recycleAfterMinutes: "0" })).recycleAfterMinutes, 1);
  assert.throws(() => parseDisposition(fromRecord({ code: "", label: "x" })), (e: unknown) => e instanceof FieldError && e.field === "code");
  assert.throws(() => parseDisposition(fromRecord({ code: "X", label: "" })), (e: unknown) => e instanceof FieldError && e.field === "label");
});

test("script and rebuttals", () => {
  assert.equal(scriptBody("  hi \n"), "hi");
  const r = parseRebuttals("Too busy | Two minutes\n\nno pipe\nA | b | c");
  assert.deepEqual(r, [
    { objection: "Too busy", response: "Two minutes" },
    { objection: "A", response: "b | c" },
  ]);
  assert.equal(rebuttalsText(r), "Too busy | Two minutes\nA | b | c");
  assert.equal(rebuttalsText(null), "");
});

test("transfer destinations: name, dialable number, a picked number for a fixed caller ID", () => {
  const t = parseTransferDestination(fromRecord({ name: " Closers ", phone: "(305) 555-0100", type: "WARM", callerIdMode: "CUSTOMER", staticCallerId: "3055550123", whisperOn: true, whisperText: " " }));
  assert.deepEqual(t, { name: "Closers", phone: "+13055550100", type: "WARM", callerIdMode: "CUSTOMER", staticCallerId: null, whisperOn: true, whisperText: null });
  assert.throws(() => parseTransferDestination(fromRecord({ name: "", phone: "3055550100" })), (e: unknown) => e instanceof FieldError && e.field === "name");
  assert.throws(() => parseTransferDestination(fromRecord({ name: "a", phone: "123" })), (e: unknown) => e instanceof FieldError && e.field === "phone");
  assert.throws(() => parseTransferDestination(fromRecord({ name: "a", phone: "3055550100", callerIdMode: "STATIC", staticCallerId: "" })), (e: unknown) => e instanceof FieldError && e.field === "staticCallerId");
  assert.equal(formatDestination("+13055550100"), "(305) 555-0100");
  assert.equal(formatDestination("+442079460958"), "+442079460958");
});

test("webhooks must be https; no events means disposition", () => {
  assert.deepEqual(parseWebhook(" https://crm.example.com/x ", ["sale", "bogus"]), { url: "https://crm.example.com/x", events: ["sale"] });
  assert.deepEqual(parseWebhook("https://a.example", []).events, ["disposition"]);
  assert.throws(() => parseWebhook("http://a.example", []), (e: unknown) => e instanceof FieldError && e.field === "url");
});

test("bets: whole numbers inside the limits; top-ups only raise active agents", () => {
  assert.deepEqual(clampBetSettings({ weeklyPoints: -5, maxStake: 0 }), { weeklyPoints: 0, maxStake: 1 });
  assert.deepEqual(clampBetSettings({ weeklyPoints: 2_000_000.4, maxStake: 250.6 }), { weeklyPoints: 1_000_000, maxStake: 251 });
  assert.deepEqual(clampBetSettings({ weeklyPoints: Number.NaN, maxStake: Number.NaN }), { weeklyPoints: 0, maxStake: 1 });
  assert.deepEqual(
    betTopUps(
      [
        { id: "a", points: 100, active: true },
        { id: "b", points: 20_000, active: true },
        { id: "c", points: 0, active: false },
      ],
      10_000,
    ),
    [{ userId: "a", delta: 9_900 }],
  );
});

function draft(): CampaignDraft {
  const settings = Object.fromEntries(CAMPAIGN_SETTING_KEYS.map((k) => [k, ""])) as CampaignDraft["settings"];
  return {
    settings: { ...settings, name: "Solar", recordingOn: true },
    lists: ["l1", "l2"],
    dialPlans: [{ key: "p1", id: "p1", leadType: "", ageFromDays: "0", ageToDays: "0", attemptsPerDay: "3", retryGapMinutes: "60", weight: "100" }],
    dispositions: [{ key: "d1", id: "d1", code: "SALE", label: "Sale", hotkey: "1", isContact: true, isSale: true, isCallback: false, isDnc: false, recycleAfterMinutes: "", active: true }],
    transfers: [
      { key: "t1", id: "t1", name: "A", phone: "+13055550100", type: "COLD", callerIdMode: "CUSTOMER", staticCallerId: "", whisperOn: true, whisperText: "", active: true },
      { key: "t2", id: "t2", name: "B", phone: "+13055550101", type: "WARM", callerIdMode: "CUSTOMER", staticCallerId: "", whisperOn: true, whisperText: "", active: true },
    ],
    webhooks: [{ key: "w1", id: "w1", url: "https://a.example", events: ["disposition"], active: true }],
    script: "Hi",
    rebuttals: "",
    bets: { betsEnabled: false, weeklyPoints: "10000", maxStake: "5000" },
  };
}

test("dirty tabs follow the edits; list order alone is not a change but transfer order is", () => {
  const a = draft();
  assert.deepEqual(dirtyTabs(a, draft()), []);
  const b = draft();
  b.settings.name = "Solar 2";
  b.settings.recordingOn = false;
  b.settings.amdEnabled = true;
  b.lists = ["l2", "l1"];
  b.script = "Hello";
  assert.deepEqual(dirtyTabs(a, b), ["dialing", "compliance", "voicemail", "script"]);
  const c = draft();
  c.transfers.reverse();
  c.webhooks = [];
  c.bets.betsEnabled = true;
  assert.deepEqual(dirtyTabs(a, c), ["transfers", "crm", "games"]);
});

test("removed rows are the saved ones the draft dropped; new rows never count", () => {
  const a = draft();
  const b = draft();
  b.lists = ["l2", "l3"];
  b.transfers = [b.transfers[1]!, { ...b.transfers[0]!, key: "new-1", id: null }];
  b.dispositions = [];
  assert.deepEqual(removedIds(a, b), { lists: ["l1"], dialPlans: [], dispositions: ["d1"], transfers: ["t1"], webhooks: [] });
});

test("rebase keeps edited tabs and takes fresh data for the rest", () => {
  const snap = draft();
  const edited = draft();
  edited.settings.name = "Mine";
  edited.dispositions[0]!.label = "Sold";
  const fresh = draft();
  fresh.settings.name = "Theirs";
  fresh.settings.recordingOn = false;
  fresh.transfers[0]!.active = false;
  fresh.dispositions[0]!.label = "Theirs";
  const out = rebaseDraft(snap, edited, fresh);
  assert.equal(out.settings.name, "Mine");
  assert.equal(out.settings.recordingOn, false);
  assert.equal(out.transfers[0]!.active, false);
  assert.equal(out.dispositions[0]!.label, "Sold");
});

test("unknown tabs fall back to dialing", () => {
  assert.equal(campaignTab("transfers"), "transfers");
  assert.equal(campaignTab("nope"), "dialing");
  assert.equal(campaignTab(undefined), "dialing");
});
