// Campaign page validation, shared by the per-section server actions and the
// single "Save campaign" action (campaigns/save-all-action.ts). Every rule
// here is the one the page has always applied; the inputs arrive as the form
// posted them (strings, checkboxes as "on" or absent), so both paths read the
// same values the same way. Checks that need the database (a fixed caller ID
// must be one of the workspace's numbers, names unique per tenant) stay in
// the web actions.
import { normalizePhone } from "./phone";
import { destinationE164 } from "./transfers";
import { DEFAULT_ASSIST_MAX_PER_CALL, DEFAULT_ASSIST_MIN_GAP_SECONDS, assistModel, clampAssistLimits } from "./assist/live";
import { DEFAULT_DISCLOSURE_PHRASES, parsePhraseList } from "./compliance/live-call";

/** Reads one posted value: the string, "on" for a ticked checkbox, null when absent. */
export type Get = (key: string) => string | null;

/** A validation failure tied to one input, so the page can highlight it. */
export class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "FieldError";
  }
}

/** A getter over a plain object: true → "on", false/null/undefined → null, anything else → String(v). */
export function fromRecord(r: object): Get {
  return (k) => {
    const v = (r as Record<string, unknown>)[k];
    if (v === true) return "on";
    if (v === false || v === null || v === undefined) return null;
    return String(v);
  };
}

/** Same as the form actions' `num`: Number(value), the fallback only when that is not finite. */
export function num(get: Get, key: string, fallback: number): number {
  const v = Number(get(key));
  return Number.isFinite(v) ? v : fallback;
}

const on = (get: Get, key: string) => get(key) === "on";

// ---- Campaign settings (Basics, Compliance, Answering machines and screeners, Caller ID)

export const CAMPAIGN_SETTING_KEYS = [
  "name",
  "status",
  "dialMode",
  "ratio",
  "maxRatio",
  "wrapUpSeconds",
  "hopperOrder",
  "listSelection",
  "closersMayDial",
  "callbackOwnerMinutes",
  "localWindowStart",
  "localWindowEnd",
  "maxAttemptsPerDay",
  "abandonCapPct",
  "abandonWarnPct",
  "abandonTimerMs",
  "recordingOn",
  "disclosureOn",
  "amdEnabled",
  "voicemailAction",
  "voicemailMode",
  "voicemailRetryMinutes",
  "voicemailScript",
  "voicemailNotifySms",
  "screenerDetection",
  "screenerAction",
  "screenerScript",
  "callerIdMode",
  "fixedCallerId",
  "callerIdFallback",
  "transcriptionOn",
  "liveAssistOn",
  "assistModel",
  "assistMinGapSeconds",
  "assistMaxPerCall",
  "spokenDisclosureRequired",
  "disclosurePhrases",
  "bannedPhrases",
  "postCallSummaryOn",
  "suggestDispositionOn",
] as const;
export type CampaignSettingKey = (typeof CAMPAIGN_SETTING_KEYS)[number];

export interface CampaignEnumsBefore {
  name: string;
  status: string;
  dialMode: string;
  voicemailAction: string;
  voicemailMode: string;
  screenerAction: string;
  callerIdMode: string;
  callerIdFallback?: string;
  hopperOrder: string;
  listSelection: string;
}

/** The campaign row update, exactly as `updateCampaign` has always computed it. */
export function parseCampaignSettings(get: Get, before: CampaignEnumsBefore) {
  const ratio = Math.max(1, num(get, "ratio", 1));
  const maxRatio = Math.max(ratio, num(get, "maxRatio", 3));
  const maxAttemptsPerDay = Math.max(1, Math.min(10, num(get, "maxAttemptsPerDay", 3)));
  return {
    name: String(get("name") ?? before.name).trim() || before.name,
    status: String(get("status") ?? before.status),
    dialMode: String(get("dialMode") ?? before.dialMode),
    ratio,
    maxRatio,
    abandonCapPct: Math.min(3, Math.max(0.5, num(get, "abandonCapPct", 3))),
    abandonWarnPct: Math.max(0.5, num(get, "abandonWarnPct", 2.5)),
    abandonTimerMs: Math.max(500, Math.min(2000, num(get, "abandonTimerMs", 2000))),
    amdEnabled: on(get, "amdEnabled"),
    voicemailNotifySms: on(get, "voicemailNotifySms"),
    voicemailAction: String(get("voicemailAction") ?? before.voicemailAction),
    voicemailMode: String(get("voicemailMode") ?? before.voicemailMode),
    voicemailScript: String(get("voicemailScript") ?? "").trim() || null,
    voicemailRetryMinutes: Math.max(15, num(get, "voicemailRetryMinutes", 240)),
    screenerDetection: on(get, "screenerDetection"),
    screenerAction: String(get("screenerAction") ?? before.screenerAction),
    screenerScript: String(get("screenerScript") ?? "").trim() || null,
    recordingOn: on(get, "recordingOn"),
    disclosureOn: on(get, "disclosureOn"),
    callerIdMode: String(get("callerIdMode") ?? before.callerIdMode),
    fixedCallerId: String(get("fixedCallerId") ?? "").replace(/\D/g, "").slice(-10) || null,
    callerIdFallback: callerIdFallback(get("callerIdFallback") ?? before.callerIdFallback),
    localWindowStart: Math.max(0, Math.min(23, num(get, "localWindowStart", 9))),
    localWindowEnd: Math.max(1, Math.min(24, num(get, "localWindowEnd", 20))),
    maxAttemptsPerDay,
    wrapUpSeconds: Math.max(0, num(get, "wrapUpSeconds", 30)),
    hopperOrder: String(get("hopperOrder") ?? before.hopperOrder),
    listSelection: String(get("listSelection") ?? before.listSelection),
    closersMayDial: on(get, "closersMayDial"),
    callbackOwnerMinutes: Math.max(0, num(get, "callbackOwnerMinutes", 30)),
    ...parseAssistSettings(get),
  };
}

/**
 * Live transcription and agent assist (the "Transcription & assist" tab).
 * Phrase lists are typed one per line; an empty disclosure list falls back
 * to the defaults (a required disclosure with nothing to listen for would
 * alert on every call). The STT-vendor check needs the engine and stays in
 * the save action.
 */
export function parseAssistSettings(get: Get) {
  const n = (k: string, d: number) => (get(k) === null || get(k) === "" ? d : num(get, k, d));
  const limits = clampAssistLimits(n("assistMinGapSeconds", DEFAULT_ASSIST_MIN_GAP_SECONDS), n("assistMaxPerCall", DEFAULT_ASSIST_MAX_PER_CALL));
  const disclosure = parsePhraseList(get("disclosurePhrases"));
  return {
    transcriptionOn: on(get, "transcriptionOn"),
    liveAssistOn: on(get, "liveAssistOn"),
    assistModel: assistModel(get("assistModel")),
    assistMinGapSeconds: limits.minGapSeconds,
    assistMaxPerCall: limits.maxPerCall,
    spokenDisclosureRequired: on(get, "spokenDisclosureRequired"),
    disclosurePhrases: disclosure.length ? disclosure : [...DEFAULT_DISCLOSURE_PHRASES],
    bannedPhrases: parsePhraseList(get("bannedPhrases")),
    postCallSummaryOn: on(get, "postCallSummaryOn"),
    suggestDispositionOn: on(get, "suggestDispositionOn"),
  };
}
export type CampaignSettings = ReturnType<typeof parseCampaignSettings>;

/** Local presence when the lead's area code has no free number: ANY (default), SAME_STATE or EXACT_ONLY. */
export function callerIdFallback(raw: string | null | undefined): "ANY" | "SAME_STATE" | "EXACT_ONLY" {
  return raw === "SAME_STATE" || raw === "EXACT_ONLY" ? raw : "ANY";
}

// ---- Dial plans by lead age

export function parseDialPlan(get: Get) {
  return {
    leadType: String(get("leadType") ?? "").trim() || null,
    ageFromDays: Math.max(0, num(get, "ageFromDays", 0)),
    ageToDays: get("ageToDays") === "" ? null : Math.max(0, num(get, "ageToDays", 0)),
    attemptsPerDay: Math.max(1, Math.min(10, num(get, "attemptsPerDay", 3))),
    retryGapMinutes: Math.max(5, num(get, "retryGapMinutes", 180)),
    weight: num(get, "weight", 0),
    active: get("active") !== "off",
  };
}

// ---- Dispositions

export function dispositionCode(raw: string | null): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 12);
}

export function parseDisposition(get: Get) {
  const code = dispositionCode(get("code"));
  const label = String(get("label") ?? "").trim();
  if (!code) throw new FieldError("code", "Code and label are required");
  if (!label) throw new FieldError("label", "Code and label are required");
  const recycle = String(get("recycleAfterMinutes") ?? "");
  return {
    code,
    label,
    hotkey: String(get("hotkey") ?? "").trim().slice(0, 1) || null,
    isContact: on(get, "isContact"),
    isSale: on(get, "isSale"),
    isDnc: on(get, "isDnc"),
    isCallback: on(get, "isCallback"),
    recycleAfterMinutes: recycle === "" ? null : Math.max(1, Number(recycle) || 1),
    active: get("active") !== "off",
  };
}

// ---- Script and rebuttals

/** The script body as stored; an unchanged body (vs the latest version) is not a new version. */
export function scriptBody(raw: string | null): string {
  return String(raw ?? "").trim();
}

/** Rebuttal library: one per line, "objection | what to say"; both halves required, at most 200. */
export function parseRebuttals(raw: string | null): { objection: string; response: string }[] {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [objection, ...rest] = l.split("|");
      return { objection: (objection ?? "").trim(), response: rest.join("|").trim() };
    })
    .filter((r) => r.objection && r.response)
    .slice(0, 200);
}

/** The textarea's text for stored rebuttals. */
export function rebuttalsText(stored: unknown): string {
  return ((stored as { objection: string; response: string }[] | null) ?? []).map((r) => `${r.objection} | ${r.response}`).join("\n");
}

// ---- Transfer destinations

/** Everything `saveTransferDestination` checks without the database. The caller still checks a STATIC number is one of the workspace's active numbers. */
export function parseTransferDestination(get: Get) {
  const name = String(get("name") ?? "").trim().slice(0, 80);
  const phone = destinationE164(String(get("phone") ?? ""));
  if (!name) throw new FieldError("name", "A destination needs a name");
  if (!phone) throw new FieldError("phone", "A destination needs a dialable number, such as (305) 555-0100 or +44 20 7946 0958");
  const type = String(get("type")) === "WARM" ? ("WARM" as const) : ("COLD" as const);
  const callerIdMode = String(get("callerIdMode")) === "STATIC" ? ("STATIC" as const) : ("CUSTOMER" as const);
  const staticRaw = normalizePhone(String(get("staticCallerId") ?? ""));
  if (callerIdMode === "STATIC" && !staticRaw) throw new FieldError("staticCallerId", "Pick one of the workspace's numbers for the fixed caller ID");
  const whisperText = String(get("whisperText") ?? "").trim().slice(0, 500) || null;
  return { name, phone, type, callerIdMode, staticCallerId: callerIdMode === "STATIC" ? staticRaw : null, whisperOn: on(get, "whisperOn"), whisperText };
}

export const STATIC_CALLER_ID_NOT_OURS = "The fixed caller ID must be one of the workspace's active numbers";

/** "(305) 555-0100" for a US destination, the E.164 string as stored for anything else. */
export function formatDestination(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (e164.startsWith("+1") && d.length === 11) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return e164;
}

// ---- CRM push (webhooks)

export const WEBHOOK_EVENTS = ["disposition", "sale", "callback", "dnc"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function parseWebhook(rawUrl: string | null, rawEvents: string[]) {
  const url = String(rawUrl ?? "").trim();
  if (!/^https:\/\//.test(url)) throw new FieldError("url", "Webhook URL must be https");
  const events = rawEvents.map(String).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  return { url, events: events.length ? events : ["disposition"] };
}
