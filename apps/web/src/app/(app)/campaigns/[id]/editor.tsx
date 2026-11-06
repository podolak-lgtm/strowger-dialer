"use client";

// Campaign detail page (owner's spec, 5 Nov): tabs, one draft, one Save.
// The server page loads a snapshot; every edit on every tab goes into the
// draft; per-tab dirty dots come from diffing the two (shared
// campaign-draft.ts). Save campaign sends the whole draft to saveCampaignAll,
// which writes it in one transaction. Immediate actions (poker run start/end,
// transfer Deactivate/Activate, webhook Test) bypass the draft.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { CAMPAIGN_TABS, SETTING_TAB, dirtyTabs, rebaseDraft, removedIds, type CampaignDraft, type CampaignTab, type DraftError, type TransferDraft } from "@strowger/shared/campaign-draft";
import { Badge } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { setLeaveGuard } from "@/lib/leave-guard";
import { saveCampaignAll } from "../save-all-action";
import { toggleTransferDestination } from "../transfer-actions";
import { EditorContext, type EditorApi } from "./editor-ui";
import { ComplianceTab, DialingTab, VoicemailTab, type PinnedNumber } from "./tab-settings";
import { CrmTab, DispositionsTab, ListsTab, type ListInfo, type WebhookInfo } from "./tab-rows";
import { TransfersTab, type CopySource, type TransferPanel } from "./tab-transfers";
import { GamesTab, ScriptTab, type RunView, type ScriptVersion } from "./tab-script-games";

const LEAVE_MESSAGE = "You have unsaved changes on this campaign. Leave without saving?";

export interface EditorProps {
  campaignId: string;
  header: { name: string; status: string; mode: string; agents: number; abandon: { text: string; tone: "green" | "amber" | "red" } };
  snapshot: CampaignDraft;
  initialTab: CampaignTab;
  lists: ListInfo[];
  webhookInfo: Record<string, WebhookInfo>;
  ownNumbers: string[];
  /** Numbers pinned to this campaign (the Dialing tab's Numbers card). */
  pinned: PinnedNumber[];
  copySources: CopySource[];
  scriptOptions: { key: string; name: string; text: string }[];
  rebuttalOptions: { key: string; name: string; text: string }[];
  rebuttalPlaceholder: string;
  versions: ScriptVersion[];
  versionCount: number;
  runs: RunView[];
  gamesError?: string;
  runDefaults: { startsAt: string; endsAt: string };
}

interface State {
  /** The props snapshot this state was last rebased on. */
  from: CampaignDraft;
  snapshot: CampaignDraft;
  draft: CampaignDraft;
}
type Action =
  | { type: "edit"; fn: (d: CampaignDraft) => CampaignDraft }
  | { type: "both"; fn: (d: CampaignDraft) => CampaignDraft }
  | { type: "rebase"; fresh: CampaignDraft }
  | { type: "saved" }
  | { type: "discard" };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "edit":
      return { ...s, draft: a.fn(s.draft) };
    case "both":
      return { ...s, draft: a.fn(s.draft), snapshot: a.fn(s.snapshot) };
    case "rebase":
      if (s.from === a.fresh) return s;
      return { ...s, from: a.fresh, snapshot: a.fresh, draft: rebaseDraft(s.snapshot, s.draft, a.fresh) };
    case "saved":
      // What was sent is now what the server holds; the refreshed snapshot (ids for new rows) replaces it when it lands.
      return { ...s, snapshot: s.draft };
    case "discard":
      return { ...s, draft: s.snapshot };
  }
}

function Toast({ toast }: { toast: { text: string; kind: "ok" | "error" } | null }) {
  if (!toast) return null;
  return (
    <div role="status" className={`fixed bottom-4 right-4 z-50 max-w-[calc(100vw-2rem)] rounded-md border px-4 py-2 text-sm shadow-lg ${toast.kind === "ok" ? "border-emerald-800 bg-emerald-950 text-emerald-200" : "border-red-800 bg-red-950 text-red-200"}`}>
      {toast.text}
    </div>
  );
}

export function CampaignEditor(p: EditorProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, p.snapshot, (snap): State => ({ from: snap, snapshot: snap, draft: snap }));
  // Fresh server data (after Save or an immediate action): rebase the draft on it, keeping unsaved tabs.
  if (state.from !== p.snapshot) dispatch({ type: "rebase", fresh: p.snapshot });

  const [tab, setTabState] = useState<CampaignTab>(p.initialTab);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [panel, setPanel] = useState<TransferPanel>(null);
  const [bandHeight, setBandHeight] = useState(0);
  const focusRef = useRef<string | null>(null);
  const leavingRef = useRef(false);
  const guardPushedRef = useRef(false);
  const saveRef = useRef<() => void>(() => undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(0);
  /** The URL this page means to show (the tab is in it); Back-cancel restores it. */
  const urlRef = useRef<string | null>(null);

  const dirty = useMemo(() => dirtyTabs(state.snapshot, state.draft), [state.snapshot, state.draft]);
  const isDirty = dirty.length > 0;
  const errorTabs = useMemo(() => new Set(Object.keys(errors).map((f) => tabOfField(f))), [errors]);

  const showToast = (text: string, kind: "ok" | "error") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), kind === "ok" ? 3000 : 6000);
  };

  const showTabInUrl = (t: CampaignTab) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    url.searchParams.delete("games");
    urlRef.current = url.toString();
    window.history.replaceState(null, "", url);
  };
  const setTab = (t: CampaignTab) => {
    setTabState(t);
    setPanel(null);
    showTabInUrl(t);
  };

  const api: EditorApi = {
    draft: state.draft,
    edit: (fn) => dispatch({ type: "edit", fn }),
    errors,
    clearError: (field) =>
      setErrors((e) => {
        if (!(field in e)) return e;
        const next = { ...e };
        delete next[field];
        return next;
      }),
    newKey: () => `new-${++keyRef.current}`,
  };

  async function save() {
    if (!isDirty || saving) return;
    // Archiving hands the campaign's numbers back to the pool; say so first.
    if (state.draft.settings.status === "ARCHIVED" && state.snapshot.settings.status !== "ARCHIVED") {
      const n = p.pinned.length;
      if (!window.confirm(`Archive this campaign? ${n ? `Its ${n} number${n === 1 ? "" : "s"} go back to the shared pool for other campaigns, and stay there if you un-archive it.` : "It has no numbers of its own."} Agents can no longer log into it.`)) return;
    }
    setSaving(true);
    try {
      const r = await saveCampaignAll(p.campaignId, { snapshot: state.snapshot, draft: state.draft, removed: removedIds(state.snapshot, state.draft) });
      if (r.ok) {
        dispatch({ type: "saved" });
        setErrors({});
        setPanel(null);
        showToast(r.warning ?? "Campaign saved", "ok");
        router.refresh();
      } else {
        jumpToErrors(r.errors);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      showToast(/was not found on the server/.test(m) ? "A new version was deployed: copy your edits, reload, and save again." : `Not saved: ${m}`, "error");
    } finally {
      setSaving(false);
    }
  }

  function jumpToErrors(list: DraftError[]) {
    const map: Record<string, string> = {};
    for (const e of list) map[e.field] = e.message;
    setErrors(map);
    const order = CAMPAIGN_TABS.map((t) => t.key);
    const first = [...list].sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab))[0];
    if (!first) return;
    setTabState(first.tab);
    showTabInUrl(first.tab);
    const m = first.field.match(/^transfers\.([^.]+)\./);
    setPanel(m ? { key: m[1]! } : null);
    focusRef.current = first.field;
    showToast(`Not saved: ${first.message}${list.length > 1 ? ` (and ${list.length - 1} more)` : ""}`, "error");
  }

  async function toggleDestination(row: TransferDraft) {
    if (!row.id) return;
    const verb = row.active ? "Deactivate" : "Activate";
    if (!window.confirm(`${verb} “${row.name}” now? This acts at once (agents ${row.active ? "stop" : "start"} seeing it), separately from Save campaign.`)) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("id", row.id);
      await toggleTransferDestination(fd);
      const active = !row.active;
      dispatch({ type: "both", fn: (d) => ({ ...d, transfers: d.transfers.map((r) => (r.id === row.id ? { ...r, active } : r)) }) });
      showToast(`${row.name} ${active ? "activated" : "deactivated"}`, "ok");
    } catch (e) {
      showToast(`Not changed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // Focus the first field with an error once its tab (and panel) is on screen.
  useEffect(() => {
    const f = focusRef.current;
    if (!f) return;
    focusRef.current = null;
    const el = document.querySelector<HTMLElement>(`[data-field="${CSS.escape(f)}"]`) ?? document.querySelector<HTMLElement>(`[data-field^="${CSS.escape(f.split(".").slice(0, 2).join("."))}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  }, [errors, tab, panel]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    saveRef.current = () => void save();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving with unsaved changes: in-app links ask (NavLink), reload/close asks (beforeunload), Back asks (a guard history entry).
  useEffect(() => {
    if (!isDirty) return;
    setLeaveGuard(LEAVE_MESSAGE);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    if (!guardPushedRef.current) {
      urlRef.current = window.location.href;
      window.history.pushState(null, "", window.location.href);
      guardPushedRef.current = true;
    }
    const onPop = () => {
      if (window.confirm(LEAVE_MESSAGE)) {
        leavingRef.current = true;
        setLeaveGuard(null);
        window.removeEventListener("popstate", onPop);
        window.history.back();
      } else {
        // Stay: put the guard entry back, at the URL of the tab on screen (Back already moved the address bar).
        window.history.pushState(null, "", urlRef.current ?? window.location.href);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPop);
    };
  }, [isDirty]);

  // Sit below the "working in client workspace" band when it is on screen.
  useEffect(() => {
    const band = document.querySelector<HTMLElement>("[data-app-band]");
    if (!band) return;
    const ro = new ResizeObserver(() => setBandHeight(band.offsetHeight));
    ro.observe(band);
    return () => ro.disconnect();
  }, []);

  const counts: Partial<Record<CampaignTab, number>> = { lists: state.draft.lists.length, transfers: state.draft.transfers.length, dispositions: state.draft.dispositions.length, crm: state.draft.webhooks.length };
  const h = p.header;

  let body: ReactNode;
  switch (tab) {
    case "dialing":
      body = <DialingTab campaignId={p.campaignId} pinned={p.pinned} />;
      break;
    case "lists":
      body = <ListsTab lists={p.lists} />;
      break;
    case "compliance":
      body = <ComplianceTab />;
      break;
    case "voicemail":
      body = <VoicemailTab />;
      break;
    case "script":
      body = <ScriptTab scriptOptions={p.scriptOptions} rebuttalOptions={p.rebuttalOptions} versions={p.versions} versionCount={p.versionCount} rebuttalPlaceholder={p.rebuttalPlaceholder} />;
      break;
    case "transfers":
      body = <TransfersTab ownNumbers={p.ownNumbers} copySources={p.copySources} panel={panel} setPanel={setPanel} onToggleActive={toggleDestination} busy={busy} />;
      break;
    case "dispositions":
      body = <DispositionsTab />;
      break;
    case "crm":
      body = <CrmTab info={p.webhookInfo} />;
      break;
    case "games":
      body = <GamesTab campaignId={p.campaignId} runs={p.runs} error={p.gamesError} runDefaults={p.runDefaults} />;
      break;
  }

  return (
    <EditorContext.Provider value={api}>
      <div className="sticky z-20 -mx-4 -mt-4 border-b border-zinc-800 bg-zinc-950/95 px-4 pt-3 text-zinc-100 backdrop-blur md:-mx-8 md:-mt-8 md:px-8" style={{ top: bandHeight }}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-nowrap">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{h.name}</h1>
              <Badge tone={h.status === "ACTIVE" ? "green" : h.status === "PAUSED" ? "amber" : "zinc"}>{h.status}</Badge>
            </div>
            <div className="mt-0.5 text-xs text-zinc-400">
              {h.mode} · {state.snapshot.lists.length} lists · {h.agents} agents · 30-day abandon <Badge tone={h.abandon.tone}>{h.abandon.text}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:flex-nowrap">
            {isDirty ? (
              <span className="whitespace-nowrap text-xs text-amber-300" aria-live="polite">
                ● Unsaved changes on {dirty.length} tab{dirty.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {isDirty ? (
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: "discard" });
                  setErrors({});
                  setPanel(null);
                }}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
              >
                Discard
              </button>
            ) : null}
            <button type="button" onClick={() => void save()} disabled={!isDirty || saving} title="Ctrl/Cmd+S" className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400">
              {saving ? "Saving…" : "Save campaign"}
            </button>
            <NavLink href={`/campaigns/${p.campaignId}/builder`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800">
              Campaign builder
            </NavLink>
          </div>
        </div>
        <nav aria-label="Campaign sections" className="mt-2 flex flex-wrap gap-x-1">
          {CAMPAIGN_TABS.map((t) => {
            const on = t.key === tab;
            const n = counts[t.key];
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t.key)}
                className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm ${on ? "border-sky-400 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
              >
                {t.label}
                {n !== undefined ? <span className="rounded bg-zinc-800 px-1.5 text-[10px] tabular-nums text-zinc-300">{n}</span> : null}
                {errorTabs.has(t.key) ? <span className="h-2 w-2 rounded-full bg-red-500" title="Has an error" /> : dirty.includes(t.key) ? <span className="h-2 w-2 rounded-full bg-orange-400" title="Unsaved changes" data-dirty-dot /> : null}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="grid items-start gap-4 pt-4 text-zinc-100 min-[900px]:grid-cols-2">{body}</div>
      <Toast toast={toast} />
    </EditorContext.Provider>
  );
}

function tabOfField(field: string): CampaignTab {
  if (field.startsWith("settings.")) return SETTING_TAB[field.slice("settings.".length) as keyof typeof SETTING_TAB] ?? "dialing";
  const head = field.split(".")[0];
  if (head === "dialPlans" || head === "lists") return "lists";
  if (head === "webhooks") return "crm";
  if (head === "script") return "script";
  return (CAMPAIGN_TABS.find((t) => t.key === head)?.key ?? "dialing") as CampaignTab;
}
