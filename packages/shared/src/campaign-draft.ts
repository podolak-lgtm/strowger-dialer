// The campaign page's draft (one Save for every tab). The page loads a
// snapshot, edits go into a copy, and per-tab dirty marks come from diffing the
// two. Values are kept as the inputs hold them (strings, booleans for
// checkboxes) and validated on Save by campaign-form.ts, so the single save
// reads exactly what the old per-section forms posted.
import type { CampaignSettingKey } from "./campaign-form";

export const CAMPAIGN_TABS = [
  { key: "dialing", label: "Dialing" },
  { key: "lists", label: "Lists & dial plans" },
  { key: "compliance", label: "Compliance" },
  { key: "voicemail", label: "Voicemail & screeners" },
  { key: "script", label: "Script & rebuttals" },
  { key: "transfers", label: "Transfers" },
  { key: "dispositions", label: "Dispositions" },
  { key: "crm", label: "CRM push" },
  { key: "games", label: "Games" },
] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number]["key"];

export function campaignTab(raw: unknown): CampaignTab {
  return CAMPAIGN_TABS.some((t) => t.key === raw) ? (raw as CampaignTab) : "dialing";
}

/** Which tab each campaign setting lives on. */
export const SETTING_TAB: Record<CampaignSettingKey, CampaignTab> = {
  name: "dialing",
  status: "dialing",
  dialMode: "dialing",
  ratio: "dialing",
  maxRatio: "dialing",
  wrapUpSeconds: "dialing",
  hopperOrder: "dialing",
  listSelection: "dialing",
  closersMayDial: "dialing",
  callbackOwnerMinutes: "dialing",
  callerIdMode: "dialing",
  fixedCallerId: "dialing",
  localWindowStart: "compliance",
  localWindowEnd: "compliance",
  maxAttemptsPerDay: "compliance",
  abandonCapPct: "compliance",
  abandonWarnPct: "compliance",
  abandonTimerMs: "compliance",
  recordingOn: "compliance",
  disclosureOn: "compliance",
  amdEnabled: "voicemail",
  voicemailAction: "voicemail",
  voicemailMode: "voicemail",
  voicemailRetryMinutes: "voicemail",
  voicemailScript: "voicemail",
  voicemailNotifySms: "voicemail",
  screenerDetection: "voicemail",
  screenerAction: "voicemail",
  screenerScript: "voicemail",
};

export type SettingsDraft = Record<CampaignSettingKey, string | boolean>;

/** Rows carry `key` (the id for a saved row, "new-…" for one added in the draft) and `id` (null until saved). */
export interface DialPlanDraft {
  key: string;
  id: string | null;
  leadType: string;
  ageFromDays: string;
  ageToDays: string;
  attemptsPerDay: string;
  retryGapMinutes: string;
  weight: string;
}
export interface DispositionDraft {
  key: string;
  id: string | null;
  code: string;
  label: string;
  hotkey: string;
  isContact: boolean;
  isSale: boolean;
  isCallback: boolean;
  isDnc: boolean;
  recycleAfterMinutes: string;
  active: boolean;
}
export interface TransferDraft {
  key: string;
  id: string | null;
  name: string;
  phone: string;
  type: "COLD" | "WARM";
  callerIdMode: "CUSTOMER" | "STATIC";
  staticCallerId: string;
  whisperOn: boolean;
  whisperText: string;
  active: boolean;
}
export interface WebhookDraft {
  key: string;
  id: string | null;
  url: string;
  events: string[];
  active: boolean;
}
export interface BetsDraft {
  betsEnabled: boolean;
  weeklyPoints: string;
  maxStake: string;
}

export interface CampaignDraft {
  settings: SettingsDraft;
  /** Ids of the lists attached to the campaign. */
  lists: string[];
  dialPlans: DialPlanDraft[];
  dispositions: DispositionDraft[];
  /** In display order: the order is what Save writes as sortOrder. */
  transfers: TransferDraft[];
  webhooks: WebhookDraft[];
  script: string;
  rebuttals: string;
  bets: BetsDraft;
}

/** The parts of the draft each tab owns. */
export function tabSlice(d: CampaignDraft, tab: CampaignTab): unknown {
  const settings = Object.fromEntries(Object.entries(d.settings).filter(([k]) => SETTING_TAB[k as CampaignSettingKey] === tab));
  switch (tab) {
    case "dialing":
    case "compliance":
    case "voicemail":
      return settings;
    case "lists":
      return { lists: [...d.lists].sort(), dialPlans: d.dialPlans };
    case "script":
      return { script: d.script, rebuttals: d.rebuttals };
    case "transfers":
      return d.transfers;
    case "dispositions":
      return d.dispositions;
    case "crm":
      return d.webhooks;
    case "games":
      return d.bets;
  }
}

/** The tabs whose part of the draft differs from the snapshot, in tab order. */
export function dirtyTabs(snapshot: CampaignDraft, draft: CampaignDraft): CampaignTab[] {
  return CAMPAIGN_TABS.map((t) => t.key).filter((t) => JSON.stringify(tabSlice(snapshot, t)) !== JSON.stringify(tabSlice(draft, t)));
}

/** Saved rows the draft no longer holds, per collection: what Save removes (or detaches). */
export function removedIds(snapshot: CampaignDraft, draft: CampaignDraft) {
  const gone = (a: { id: string | null }[], b: { id: string | null }[]) => {
    const keep = new Set(b.map((r) => r.id).filter(Boolean));
    return a.map((r) => r.id).filter((id): id is string => Boolean(id) && !keep.has(id));
  };
  const keepLists = new Set(draft.lists);
  return {
    lists: snapshot.lists.filter((id) => !keepLists.has(id)),
    dialPlans: gone(snapshot.dialPlans, draft.dialPlans),
    dispositions: gone(snapshot.dispositions, draft.dispositions),
    transfers: gone(snapshot.transfers, draft.transfers),
    webhooks: gone(snapshot.webhooks, draft.webhooks),
  };
}
export type RemovedIds = ReturnType<typeof removedIds>;

/**
 * Fresh server data arrived (after Save, or after an immediate action such as
 * Deactivate): tabs with no unsaved edits take the new data, tabs with edits
 * keep them. Returns the new draft; the new snapshot is `fresh`.
 */
export function rebaseDraft(oldSnapshot: CampaignDraft, draft: CampaignDraft, fresh: CampaignDraft): CampaignDraft {
  const dirty = new Set(dirtyTabs(oldSnapshot, draft));
  const settings = { ...fresh.settings };
  for (const k of Object.keys(settings) as CampaignSettingKey[]) if (dirty.has(SETTING_TAB[k])) settings[k] = draft.settings[k];
  return {
    settings,
    lists: dirty.has("lists") ? draft.lists : fresh.lists,
    dialPlans: dirty.has("lists") ? draft.dialPlans : fresh.dialPlans,
    dispositions: dirty.has("dispositions") ? draft.dispositions : fresh.dispositions,
    transfers: dirty.has("transfers") ? draft.transfers : fresh.transfers,
    webhooks: dirty.has("crm") ? draft.webhooks : fresh.webhooks,
    script: dirty.has("script") ? draft.script : fresh.script,
    rebuttals: dirty.has("script") ? draft.rebuttals : fresh.rebuttals,
    bets: dirty.has("games") ? draft.bets : fresh.bets,
  };
}

/** A validation error from Save, tied to a tab and an input ("settings.name", "dispositions.<key>.code", "games.weeklyPoints"). */
export interface DraftError {
  tab: CampaignTab;
  field: string;
  message: string;
}
