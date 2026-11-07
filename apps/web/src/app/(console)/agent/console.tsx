"use client";

// The agent console. One component, two screens:
//   ?screen=main   (default) status banner, lead card, call controls +
//                  dispositions (one block), activity feed
//   ?screen=assist upcoming leads, leaderboard, goals, agent assist
// Open /agent?screen=assist in a second window for a two-monitor desk; on
// one monitor every column collapses with the chevrons.
import { createJambonzClient } from "@jambonz/client-sdk-web";
import { ChatPanel } from "@/components/chat-panel";
import { AssistCards, ComplianceBanner, ScriptChecklist, TranscriptPanel, useLiveCall } from "@/components/live-call";
import { keepAiSummaries } from "@strowger/shared/assist";
import { isStaleBuildError, NewVersionBanner, useNewVersion } from "@/components/new-version";
import { myTeams } from "@/lib/chat-actions";
import { assistSuggest, campaignRebuttals, type Suggestion } from "@/lib/games-actions";
import { GamesLayer, GamesPanel, PointsPurse, useGames } from "./games";
import { useAudioWatchdog } from "./audio-watchdog";
import { askPhoneChannel, newTabId, phoneChannelName, playAllAudio, postPhone, SUPERVISION_ANSWER_WINDOW_MS, withTimeout, type PhoneMsg } from "@/lib/phone-lock";
import { superviseStart, superviseStop, type SuperviseMode } from "../floor/actions";
import { formatPhone } from "@strowger/shared/phone";
import { DEFAULT_SCREENER_SCRIPT, renderScript } from "@strowger/shared/scripts";
import { io, type Socket } from "socket.io-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentCurrent,
  agentLogin,
  campaignScript,
  myCallbacks,
  upcomingLeads,
  agentLogout,
  agentSetState,
  lineTakeover,
  callScreener,
  screenerSaidIt,
  dialLead,
  disposition,
  hangup,
  holdCall,
  leadById,
  leadForCall,
  reportAudioProblem,
  leadHistory,
  leaveVoicemail,
  manualDial,
  transferCall,
  transferTargets,
  transferToDestination,
  transferLeave,
  transferCancel,
  currentTransfer,
  nextLead,
  sendText,
  skipLead,
  sprint,
  textThread,
  updateLead,
  setLeadVip,
  type AgentLive,
  type LeadCard,
  type LeadEdit,
  type LeadHistory,
  type LiveTransferView,
  type MyCallback,
  type Sprint,
  type TextMessage,
  type TransferTarget,
  type UpcomingLead,
} from "./actions";

type JambonzClient = ReturnType<typeof createJambonzClient>;
type JambonzCall = ReturnType<JambonzClient["call"]>;

export interface ConsoleProps {
  me: { id: string; name: string; tenant: string };
  /** TEAM_LEADER gets the My Team panel: members live, listen/whisper/barge, a word in chat. */
  roles: string[];
  /** From the agent level (lib/rights.ts). Buttons are hidden without the right; the actions refuse too. */
  rights: string[];
  /** Prepaid balance state; shown in the top bar when it needs attention. */
  billing: { balanceCents: number; low: boolean; critical: boolean; suspended: boolean; isPlatform: boolean; graceDays: number } | null;
  campaigns: Array<{
    id: string;
    name: string;
    dialMode: "RATIO" | "PREVIEW";
    agentMode: "FRONTER" | "CLOSER" | "BOTH";
    outboundOn: boolean;
    closersMayDial: boolean;
    wrapUpSeconds: number;
    /** Quick "Callback" is due this many minutes out (60 when 0). */
    callbackOwnerMinutes: number;
    /** Read to a phone's call screener (SCREENER banner); null = DEFAULT_SCREENER_SCRIPT. */
    screenerScript: string | null;
    dispositions: Array<{ id: string; code: string; label: string; hotkey: string | null; isCallback: boolean; isSale: boolean; isDnc: boolean }>;
    /** Where a live lead can be handed (campaign page → Transfers). `type` is the default for the cold/warm flip. */
    transferDestinations: Array<{ id: string; name: string; type: "COLD" | "WARM"; callerIdMode: "CUSTOMER" | "STATIC"; staticCallerId: string | null }>;
  }>;
  sip: { server: string; realm: string; username: string; password: string; applicationSid: string } | null;
  engineUrl: string;
  rtToken: string;
  screen: "main" | "assist";
  /** Build that rendered this page; /api/version is polled against it (lib/version.ts). */
  version: string;
}

type PhoneState = "off" | "connecting" | "registered" | "error" | "in-room";

const PAUSE_REASONS = ["Break", "Lunch", "Meeting", "Coaching", "Technical"];

function useTicker(active: boolean, from: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!from) return "00:00";
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Waveform({ className = "", colors }: { className?: string; colors: [string, string] }) {
  const bars = useMemo(() => Array.from({ length: 28 }, (_, i) => ({ h: 20 + Math.round(60 * Math.abs(Math.sin(i * 0.9))), d: (i % 7) * 0.12 })), []);
  return (
    <div className={`flex h-12 items-center gap-[3px] ${className}`} aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full opacity-80"
          style={{ height: `${b.h}%`, background: `linear-gradient(180deg, ${colors[0]}, ${colors[1]})`, animation: `sw-pulse 1.6s ease-in-out ${b.d}s infinite` }}
        />
      ))}
    </div>
  );
}

function Panel({ title, children, right, collapsible = true, defaultOpen = true, className = "" }: { title: string; children: React.ReactNode; right?: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
        <div className="flex items-center gap-2">
          {right}
          {collapsible ? (
            <button onClick={() => setOpen((o) => !o)} className="rounded-md px-1.5 text-xs text-zinc-400 hover:bg-white/10" title={open ? "Collapse" : "Expand"}>
              {open ? "▾" : "▸"}
            </button>
          ) : null}
        </div>
      </header>
      {open ? children : null}
    </section>
  );
}

function Bar({ label, value, max, from, to }: { label: string; value: number; max: number; from: string; to: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return (
    <div className="mb-3">
      <div className="mb-1 flex justify-between text-xs text-zinc-300">
        <span>{label}</span>
        <span className="tabular-nums">
          {value}/{max} · {pct}%
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${from}, ${to})`, boxShadow: `0 0 12px ${to}66` }} />
      </div>
    </div>
  );
}

/** The live transfer's status line: a pulsing dot and a ring timer while it rings, green once connected. */
function TransferStatus({ transfer, startedAt }: { transfer: LiveTransferView; startedAt: number | null }) {
  const now = useNow(1000);
  const secs = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  if (transfer.state === "ringing") {
    return (
      <span className="flex flex-wrap items-center gap-2 font-medium text-violet-100">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-300 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-violet-300" />
        </span>
        {transfer.id === "pending" ? `Calling ${transfer.destinationName}…` : `Ringing ${transfer.destinationName}…`}
        {secs !== null ? <span className="font-mono text-xs text-violet-300/80">{secs}s of 25</span> : null}
        <span className="text-xs font-normal text-violet-300/70">The lead hears the ring with you.</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 font-medium text-emerald-200">
      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
      {transfer.mode === "WARM" ? `Connected: ${transfer.destinationName} is on with you and the lead. Introduce them, then Leave.` : `${transfer.destinationName} answered. Handing the lead off…`}
    </span>
  );
}

/** Cancel stays greyed for the first 3 s after Dial, so a second click on a slow-looking screen cannot cancel the call it just placed. */
function CancelTransferButton({ onCancel, disabled, startedAt }: { onCancel: () => void; disabled: boolean; startedAt: number | null }) {
  const now = useNow(500);
  const guarded = startedAt !== null && now - startedAt < 3000;
  return (
    <button onClick={onCancel} disabled={disabled || guarded} title="Drop the destination; you keep the lead" className="rounded-lg border border-red-400/30 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/10 disabled:opacity-40">
      Cancel transfer
    </button>
  );
}

/** Wall clock that re-renders every `everyMs`, for the lead's local time. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function leadLocalTime(lead: LeadCard | null, now: number): string | null {
  if (!lead?.timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: lead.timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(now));
  } catch {
    return null;
  }
}

const SCRUB_BADGE: Record<string, { label: string; className: string }> = {
  CLEAN: { label: "clean", className: "bg-emerald-500/20 text-emerald-200" },
  PENDING: { label: "scrub pending", className: "bg-amber-500/20 text-amber-200" },
  FAILED: { label: "scrub failed", className: "bg-zinc-500/30 text-zinc-200" },
  DNC: { label: "DNC", className: "bg-red-500/30 text-red-200" },
  LITIGATOR: { label: "litigator", className: "bg-red-500/30 text-red-200" },
};

const EDIT_FIELDS: Array<{ key: keyof LeadEdit; label: string; span?: boolean; autoComplete?: string }> = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email", span: true },
  { key: "address", label: "Address", span: true },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
];

function editable(lead: LeadCard): Required<LeadEdit> {
  return { firstName: lead.firstName ?? "", lastName: lead.lastName ?? "", email: lead.email ?? "", address: lead.address ?? "", city: lead.city ?? "", state: lead.state ?? "", zip: lead.zip ?? "" };
}

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`truncate text-sm text-zinc-200 ${mono ? "font-mono" : ""}`}>{children}</div>
    </div>
  );
}

/**
 * The Lead card (owner, 5 Nov): every field the lead carries, the agent
 * edits name / email / address inline and keeps running notes. Mount it with
 * `key={lead.id}` so the form resets when another lead comes on screen.
 */
function LeadCardEditor({ lead, notes, onNotes, onNotesBlur, onSave, busy, now, right }: { lead: LeadCard; notes: string; onNotes: (v: string) => void; onNotesBlur: () => void; onSave: (fields: LeadEdit) => Promise<void>; busy: boolean; now: number; right?: React.ReactNode }) {
  const [form, setForm] = useState<Required<LeadEdit>>(() => editable(lead));
  const saved = editable(lead);
  const dirty = EDIT_FIELDS.some(({ key }) => form[key].trim() !== saved[key]);
  // Autosave (owner, 5 Nov: "they may forget to hit save"): a second after typing stops, and at once on leaving a field.
  // The parent re-renders every second for the clock, so the save callback is read through a ref, not a dependency.
  const saveRef = useRef(onSave);
  const lastSent = useRef("");
  useEffect(() => {
    saveRef.current = onSave;
  });
  const flush = (f: Required<LeadEdit>) => {
    const k = JSON.stringify(f);
    if (k === lastSent.current) return;
    lastSent.current = k;
    void saveRef.current(f);
  };
  const formKey = JSON.stringify(form);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => flush(JSON.parse(formKey) as Required<LeadEdit>), 1000);
    return () => clearTimeout(t);
  }, [formKey, dirty]);
  const localTime = leadLocalTime(lead, now);
  const scrub = SCRUB_BADGE[lead.scrubStatus] ?? { label: lead.scrubStatus.toLowerCase(), className: "bg-white/10 text-zinc-300" };
  const consent = [
    lead.consentJornayaId ? { k: "Jornaya ID", v: lead.consentJornayaId } : null,
    lead.consentTrustedFormId ? { k: "TrustedForm", v: lead.consentTrustedFormId } : null,
    lead.optInAt ? { k: "Opted in", v: `${new Date(lead.optInAt).toLocaleString()}${lead.optInIp ? ` from ${lead.optInIp}` : ""}` } : null,
  ].filter((x): x is { k: string; v: string } => Boolean(x));
  const input = "mt-0.5 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-400/50 focus:outline-none";

  return (
    <Panel
      title="Lead"
      collapsible={false}
      right={
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs ${scrub.className}`}>{scrub.label}</span>
          {right}
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void onSave(form);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-black/30 p-3">
          <div>
            <div className="font-mono text-lg text-zinc-100">{formatPhone(lead.phone)}</div>
            <div className="text-xs text-zinc-400">{localTime ? `Local time ${localTime}` : "Local time unknown"}{lead.timezone ? ` · ${lead.timezone}` : ""}</div>
          </div>
          <div className="flex flex-wrap gap-1">
            {lead.leadType ? <span className="rounded bg-fuchsia-500/20 px-1.5 py-0.5 text-xs text-fuchsia-200">{lead.leadType}</span> : null}
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-zinc-300">{lead.status.toLowerCase().replace("_", " ")}</span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-zinc-300">{lead.attemptsTotal} attempts</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {EDIT_FIELDS.map((f) => (
            <label key={f.key} className={`block text-[11px] uppercase tracking-wide text-zinc-500 ${f.span ? "col-span-2" : ""}`}>
              {f.label}
              <input value={form[f.key]} onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))} onBlur={() => dirty && flush(form)} className={input} />
            </label>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="List">{lead.listName}</Field>
          <Field label="Affiliate">{lead.affiliateName ?? "—"}</Field>
          <Field label="Posted">{new Date(lead.postedAt).toLocaleString()}</Field>
          <Field label="Owner">{lead.ownerName ?? "unassigned"}</Field>
          <Field label="Last attempt">{lead.lastAttemptAt ? new Date(lead.lastAttemptAt).toLocaleString() : "never"}</Field>
          <Field label="Last outcome">{lead.lastOutcome ? lead.lastOutcome.toLowerCase().replace(/_/g, " ") : "—"}</Field>
          <Field label="Scrub">
            {scrub.label}
            {lead.scrubReason ? <span className="text-zinc-500"> · {lead.scrubReason}</span> : null}
          </Field>
          <Field label="Lead ID" mono>
            {lead.id}
          </Field>
        </div>

        <div className="rounded-lg bg-black/30 p-3 text-xs">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Consent</div>
          {consent.length === 0 && !lead.optInUrl ? <div className="text-zinc-500">No consent details on this lead.</div> : null}
          {consent.map((c) => (
            <div key={c.k} className="flex justify-between gap-3">
              <span className="text-zinc-500">{c.k}</span>
              <span className="truncate font-mono text-zinc-300">{c.v}</span>
            </div>
          ))}
          {lead.optInUrl ? (
            <div className="flex justify-between gap-3">
              <span className="text-zinc-500">Opt-in page</span>
              <a href={lead.optInUrl} target="_blank" rel="noreferrer" className="truncate text-sky-300 hover:underline">
                {lead.optInUrl}
              </a>
            </div>
          ) : null}
        </div>

        {Object.keys(lead.custom ?? {}).length ? (
          <div className="rounded-lg bg-black/30 p-3 text-xs">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Other fields</div>
            {Object.entries(lead.custom).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-zinc-500">{k}</span>
                <span className="truncate text-zinc-300">{typeof v === "string" ? v : JSON.stringify(v)}</span>
              </div>
            ))}
          </div>
        ) : null}

        <label className="block text-[11px] uppercase tracking-wide text-zinc-500">
          Notes <span className="normal-case text-zinc-600">(saved as you type)</span>
          <textarea value={notes} onChange={(e) => onNotes(e.target.value)} onBlur={onNotesBlur} placeholder="Notes about this lead…" rows={4} className={`${input} normal-case tracking-normal`} />
        </label>

        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">{dirty ? "Saving…" : "All changes saved"}</span>
          <div className="flex gap-2">
            {dirty ? (
              <button type="button" onClick={() => setForm(saved)} disabled={busy} className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10 disabled:opacity-40">
                Revert
              </button>
            ) : null}
            <button type="submit" disabled={busy || !dirty} className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      </form>
    </Panel>
  );
}

/** Assist screen: the current-lead row in Lead Queue opens the same editable card. */
function CollapsibleLeadCard({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-lg border border-sky-400/30 bg-sky-400/10 text-sm text-zinc-100">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 px-3 py-2 text-left" title={open ? "Hide the lead card" : "Open the lead card"}>
        <span className="pt-0.5 text-xs text-zinc-400">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open ? <div className="border-t border-sky-400/20 p-2">{children}</div> : null}
    </div>
  );
}

export function AgentConsole(props: ConsoleProps) {
  const { me, campaigns, sip, engineUrl, rtToken, screen, roles, rights, billing, version } = props;
  // Primitive SIP settings for hook deps: the `sip` object is a new one on every server render.
  const hasSip = Boolean(sip);
  const sipServer = sip?.server ?? "";
  const sipUser = sip?.username ?? "";
  const sipPassword = sip?.password ?? "";
  const sipRealm = sip?.realm ?? "";
  const sipAppSid = sip?.applicationSid ?? "";
  const can = (r: string) => rights.includes(r);
  const [campaignId, setCampaignId] = useState<string>(campaigns[0]?.id ?? "");
  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;
  const [agent, setAgent] = useState<AgentLive | null>(null);
  // Registration of this window's SIP client, and the agent's nailed-up line (the room leg), kept apart so a
  // registration event can never overwrite "in room" (HANDOFF "Call path hardening, browser").
  const [reg, setReg] = useState<Exclude<PhoneState, "in-room">>("off");
  const [line, setLine] = useState<"down" | "raising" | "up">("down");
  const phone: PhoneState = line === "up" ? "in-room" : reg;
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [lead, setLead] = useState<LeadCard | null>(null);
  const [history, setHistory] = useState<LeadHistory>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState<string>("idle");
  const [callStart, setCallStart] = useState<number | null>(null);
  /** The live call is a screened one (engine call:update carries screener: true); the banner's step moves say → wait → go. */
  const [screener, setScreener] = useState<{ phrase: string | null } | null>(null);
  const [screenerStep, setScreenerStep] = useState<"say" | "wait" | "go">("say");
  /** A caller handed over by the AI answer: its summary and the conversation so far (inbound/ai). */
  const [aiNote, setAiNote] = useState<{ summary: string; transcript: Array<{ role: string; text: string }> } | null>(null);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  // "Scheduled callback" opens the date/time picker; the disposition is sent on Submit.
  const [scheduling, setScheduling] = useState(false);
  const [stats, setStats] = useState<Sprint | null>(null);
  const [thread, setThread] = useState<TextMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [upcoming, setUpcoming] = useState<UpcomingLead[]>([]);
  const [callbacks, setCallbacks] = useState<MyCallback[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [twoScreen, setTwoScreen] = useState(false);
  const [held, setHeld] = useState(false);
  const [targets, setTargets] = useState<TransferTarget[] | null>(null);
  // External transfer in flight on this call, and the dropdown that starts one.
  const [transfer, setTransfer] = useState<LiveTransferView | null>(null);
  const [xferMenu, setXferMenu] = useState(false);
  /** When the agent clicked Dial on the transfer, for the ring timer and the Cancel guard. */
  const [xferStartedAt, setXferStartedAt] = useState<number | null>(null);
  /** The agent's cold/warm flip per destination (defaults from the campaign page). */
  const [xferModes, setXferModes] = useState<Record<string, "COLD" | "WARM">>({});
  const [manual, setManual] = useState("");
  const assistWin = useRef<Window | null>(null);
  const [busy, setBusy] = useState(false);
  const [pauseMenu, setPauseMenu] = useState<null | "bar" | "banner">(null);
  const [sock, setSock] = useState<Socket | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string; members: { id: string; name: string }[] }[]>([]);
  const [liveAgents, setLiveAgents] = useState<Record<string, AgentLive>>({});
  const [dmWith, setDmWith] = useState<string | null>(null);
  const [watching, setWatching] = useState<{ agentId: string; mode: SuperviseMode } | null>(null);
  // A deploy changes every Server Action id; this page then fails on any click.
  const { stale: newVersion, markStale } = useNewVersion(version);
  const isLeader = roles.includes("TEAM_LEADER") || roles.includes("SUPERVISOR") || roles.includes("ADMIN");
  const canVip = roles.includes("SUPERVISOR") || roles.includes("ADMIN");

  const clientRef = useRef<JambonzClient | null>(null);
  const roomCallRef = useRef<JambonzCall | null>(null);
  // One automatic re-register after a failure; after that the "phone error" badge / banner is the retry.
  const phoneAutoRetriedRef = useRef(false);
  // One phone per browser (owner, 7 Nov): another console window that already holds the phone keeps it. This
  // window only takes it over when the agent clicks "Use the phone here" (the other window then hangs up and lets go).
  // "idle": another window has it, "use it here" takes it; "busy": that window is on a call and keeps it.
  const [phoneElsewhere, setPhoneElsewhere] = useState<false | "idle" | "busy">(false);
  const tabIdRef = useRef<string>("");
  const phoneChanRef = useRef<BroadcastChannel | null>(null);
  /** This window holds the browser's phone lock: claimed before connecting, so it answers "mine" while connecting. */
  const holdingRef = useRef(false);
  /** The client between createJambonzClient() and a finished connect(), so a failure or teardown can disconnect it. */
  const pendingClientRef = useRef<JambonzClient | null>(null);
  /** connectPhone() in flight: a second call while the first is still connecting does nothing. */
  const connectingRef = useRef(false);
  /** Bumped on teardown: a connect that finishes after it throws its client away. */
  const phoneGenRef = useRef(0);
  /** When this page last asked for a supervision leg (TeamPanel); only then is an INVITE answered. */
  const pendingSupervisionAtRef = useRef(0);
  /** The agent's state for channel handlers ("release" is refused on a call or in wrap-up). */
  const agentStateRef = useRef<string>("LOGGED_OUT");
  /** The engine refused this window's line: another window or device has the agent's call screen. */
  const [lineRefused, setLineRefused] = useState(false);
  /** The browser refused to play the call audio without a click (SDK "jambonz-audio-blocked"). */
  const [audioBlocked, setAudioBlocked] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  // The campaign on screen, for socket handlers that outlive a campaign switch.
  const campaignIdRef = useRef(campaignId);
  useEffect(() => {
    campaignIdRef.current = campaignId;
  }, [campaignId]);
  // Dispositioning a live call hangs it up first; the lead leg's "ended" event
  // can then land after the disposition cleared the call. Ignore it for that id.
  const dispositionedRef = useRef<string | null>(null);
  /** The call on screen, readable from socket handlers that outlive a render. */
  const callIdRef = useRef<string | null>(null);
  useEffect(() => {
    callIdRef.current = callId;
  }, [callId]);
  /** The lead on screen, for the post-call summary landing in its notes box. */
  const leadIdRef = useRef<string | null>(null);
  useEffect(() => {
    leadIdRef.current = lead?.id ?? null;
  }, [lead]);
  // Live transcription and assist for the call on screen (components/live-call.tsx, engine assist/live.ts).
  const live = useLiveCall(sock, callId);
  const liveOn = Boolean(live.status?.on || live.turns.length || live.partial.CUSTOMER || live.partial.AGENT);
  // A reload mid-call: pick up the transfer in flight, if any.
  useEffect(() => {
    if (!callId) return;
    const t = setTimeout(() => void currentTransfer(callId).then((x) => x && setTransfer(x)).catch(() => undefined), 0);
    return () => clearTimeout(t);
  }, [callId]);

  const timer = useTicker(callStatus !== "idle" && callStatus !== "ended", callStart);
  const now = useNow(30_000);

  /** Put a lead on screen: card, its persisted notes, its history. */
  const showLead = useCallback((l: LeadCard) => {
    setLead(l);
    setNotes(l.notes ?? "");
    void leadHistory(l.id).then(setHistory);
  }, []);

  /** Listen / whisper / barge on a team member, or stop. Needs my own line idle (registered, not in a room). */
  const watch = useCallback(async (agentId: string, mode: SuperviseMode | null) => {
    if (!mode) {
      await superviseStop();
      setWatching(null);
      return;
    }
    // Only an INVITE that follows this click is answered (connectPhone's "incoming").
    pendingSupervisionAtRef.current = Date.now();
    const r = await superviseStart(agentId, mode);
    if (r.ok) setWatching({ agentId, mode });
    else setNotice(r.error);
  }, []);
  const stateSince = useTicker(Boolean(agent), agent?.since ?? null);

  const refreshStats = useCallback(async () => {
    try {
      const [st, up, cb, sc] = await Promise.all([sprint(campaignId || null), upcomingLeads(campaignId || null), myCallbacks(campaignId || null), campaignScript(campaignId || null)]);
      setStats(st);
      setUpcoming(up);
      setCallbacks(cb);
      setScript(sc);
    } catch {
      /* decoration */
    }
  }, [campaignId]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setTwoScreen(localStorage.getItem("strowger.twoScreen") === "1");
      } catch {
        /* no storage */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  /** Open (or focus) the assist window; must run inside a click so the browser allows it. */
  const openAssist = useCallback(() => {
    if (screen !== "main") return;
    if (assistWin.current && !assistWin.current.closed) {
      assistWin.current.focus();
      return;
    }
    assistWin.current = window.open("/agent?screen=assist", "strowger-assist", "popup=yes,width=1280,height=900");
  }, [screen]);

  const toggleTwoScreen = () => {
    const next = !twoScreen;
    setTwoScreen(next);
    try {
      localStorage.setItem("strowger.twoScreen", next ? "1" : "0");
    } catch {
      /* no storage */
    }
    if (next) openAssist();
  };

  // Pick up a session that already exists (page reload).
  useEffect(() => {
    void (async () => {
      const cur = await agentCurrent();
      if (cur) {
        setAgent(cur);
        if (cur.campaignId) setCampaignId(cur.campaignId);
        if (cur.currentCallId) {
          setCallId(cur.currentCallId);
          setCallStatus(cur.state === "WRAP_UP" ? "ended" : "bridged");
          // A reload mid-call or in wrap-up brings the lead card back (agents reload after every deploy).
          void leadForCall(cur.currentCallId).then((l) => {
            if (l) showLead(l);
          });
          void callScreener(cur.currentCallId).then((info) => {
            if (info?.screener && info.status !== "ended") setScreener({ phrase: info.screenerPhrase });
            if (info?.aiSummary) setAiNote({ summary: info.aiSummary, transcript: info.aiTranscript ?? [] });
          });
        }
      }
    })();
  }, [showLead]);

  useEffect(() => {
    const first = setTimeout(() => void refreshStats(), 0);
    const t = setInterval(() => void refreshStats(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refreshStats]);

  // Text thread follows the lead on screen.
  useEffect(() => {
    if (!lead) {
      const t = setTimeout(() => setThread([]), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => void textThread(lead.id).then(setThread), 0);
    return () => clearTimeout(t);
  }, [lead]);

  // Realtime from the engine.
  useEffect(() => {
    const sock = io(engineUrl, { path: "/rt", auth: { token: rtToken }, transports: ["websocket"] });
    socketRef.current = sock;
    const announce = setTimeout(() => setSock(sock), 0);
    sock.on("floor:agent", (live: AgentLive & { state: string }) => {
      setLiveAgents((prev) => {
        if (live.state === "LOGGED_OUT") {
          const next = { ...prev };
          delete next[live.userId];
          return next;
        }
        return { ...prev, [live.userId]: live };
      });
    });
    sock.on("agent:state", (live: AgentLive) => {
      if (live.userId !== me.id) return;
      setAgent(live.state === "LOGGED_OUT" ? null : live);
      if (screen === "assist") {
        const id = live.reservedLeadId ?? null;
        if (id) void leadById(id).then((l) => l && showLead(l));
        if (!id && !live.currentCallId) setLead(null);
      }
      if (live.currentCallId && live.currentCallId !== callId) setCallId(live.currentCallId);
      if (live.state === "READY" && !live.currentCallId) {
        setCallId(null);
        setCallStatus("idle");
        setCallStart(null);
        setAiNote(null);
        setScreener(null);
        setScreenerStep("say");
        setTransfer(null);
        setXferMenu(false);
      }
    });
    // After the call: the engine appended an AI summary to the lead's notes; add it to the box without losing what is being typed.
    sock.on("call:summary", (p: { leadId: string | null; notes: string | null }) => {
      if (p.notes && p.leadId && p.leadId === leadIdRef.current) setNotes((cur) => keepAiSummaries(p.notes, cur));
    });
    sock.on("text:in", (m: { leadId: string | null; body: string; from: string; action?: string; intent?: string | null }) => {
      const flag = m.action === "opt_out" ? " · OPTED OUT, lead closed" : m.action === "review" ? " · possible opt-out, check before calling" : m.action === "callback" ? " · callback booked" : "";
      setNotice(`Text from ${m.from.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}: ${m.body.slice(0, 80)}${flag}`);
      if (m.leadId) void textThread(m.leadId).then(setThread);
      void refreshStats();
    });
    // Games: a run starting or bets switching on for the campaign on screen is announced here; the panel reloads itself.
    sock.on("games:run", (r: { status: "ACTIVE" | "ENDED"; campaignId: string; campaign: string; name: string; prize: string | null; winner?: { name: string; hand: string } | null }) => {
      if (r.campaignId !== campaignIdRef.current) return;
      if (r.status === "ACTIVE") setNotice(`Poker run '${r.name}' started on ${r.campaign}${r.prize ? `: ${r.prize}` : ""}`);
      else setNotice(`Poker run '${r.name}' ended: ${r.winner ? `${r.winner.name} wins with ${r.winner.hand}` : "nobody held a card"}`);
    });
    sock.on("games:bets", (b: { campaignId: string; campaign: string; betsEnabled: boolean; weeklyPoints: number }) => {
      if (b.campaignId !== campaignIdRef.current) return;
      setNotice(b.betsEnabled ? `Bets are on for ${b.campaign}: ${b.weeklyPoints.toLocaleString()} points every Monday` : `Bets are off for ${b.campaign}`);
    });
    sock.on("games:won", (w: { name: string; prize: string | null; hand: string }) => setNotice(`You won the poker run '${w.name}' with ${w.hand}${w.prize ? `: ${w.prize}` : ""}`));
    // A card earned on a disposition plays as the deal moment (games.tsx GamesLayer), held while on a call.
    sock.on("call:update", (u: { callId: string; status: string; leadId?: string; outcome?: string; inbound?: boolean; from?: string | null; screener?: boolean; screenerPhrase?: string | null; human?: boolean; transfer?: LiveTransferView; queue?: string; queueCallback?: string; waitedSeconds?: number; survey?: boolean; aiSummary?: string; aiTranscript?: Array<{ role: string; text: string }> }) => {
      // The queue's wrap-up timer ran out (inbound/queues.ts): the call is done, the screen clears.
      if (u.status === "wrapped") {
        if (callIdRef.current === u.callId) {
          setCallId(null);
          setCallStatus("idle");
          setCallStart(null);
          setAiNote(null);
          setScreener(null);
          setScreenerStep("say");
          setTransfer(null);
          setXferMenu(false);
        }
        void refreshStats();
        return;
      }
      if (u.status === "transfer" && u.transfer) {
        const t = u.transfer;
        setXferMenu(false);
        if (t.state === "no_answer") setNotice(`No answer at ${t.destinationName}. You still have the lead.`);
        else if (t.state === "failed") setNotice(`Could not reach ${t.destinationName}. You still have the lead.`);
        else if (t.state === "cancelled") setNotice(`Transfer to ${t.destinationName} cancelled. You still have the lead.`);
        else if (t.state === "answered") setNotice(t.callerIdFallback ? `${t.destinationName} answered. Caller ID fell back to the campaign's number.` : null);
        else if (t.state === "left") setNotice(`You left the call: the lead is with ${t.destinationName}. Dispositioned "${t.dispositionLabel ?? "Transferred"}"; keep it or change it below.`);
        else if (t.state === "ended" && !t.agentLeftAt) setNotice(`${t.destinationName} hung up. You still have the lead.`);
        const over = t.state === "no_answer" || t.state === "failed" || t.state === "cancelled" || (t.state === "ended" && !t.agentLeftAt);
        // "ended" after leaving keeps the disposition the "left" event carried, for the Keep button in wrap-up.
        setTransfer((prev) => (over ? null : { ...t, dispositionId: t.dispositionId ?? prev?.dispositionId ?? null, dispositionLabel: t.dispositionLabel ?? prev?.dispositionLabel ?? null }));
        return;
      }
      if (u.status === "ended" && u.callId === dispositionedRef.current) {
        void refreshStats();
        return;
      }
      if (u.status === "ended" && callIdRef.current && u.callId !== callIdRef.current) {
        void refreshStats();
        return;
      }
      if (callIdRef.current !== u.callId) {
        // A new call: whatever the last one was, this one starts clean.
        setScreener(null);
        setScreenerStep("say");
        setAiNote(null);
      }
      // The AI answer spoke to this caller first: its summary (a better one may follow a second later) and transcript.
      if (u.aiSummary || u.aiTranscript) setAiNote((cur) => ({ summary: u.aiSummary ?? cur?.summary ?? "", transcript: u.aiTranscript ?? cur?.transcript ?? [] }));
      setCallId(u.callId);
      setCallStatus(u.status);
      if (u.screener) setScreener((cur) => cur ?? { phrase: u.screenerPhrase ?? null });
      if (u.human) setScreenerStep("go");
      const fromText = u.from ? ` ${u.from.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}` : "";
      if (u.queueCallback) setNotice(`Queue callback for ${u.queueCallback}:${fromText || " the caller"} ${u.status === "dialing" ? "is being dialled" : "is on the line"}. They asked for this call.`);
      else if (u.queue) setNotice(`Inbound call from${fromText || " a caller"} via ${u.queue}${typeof u.waitedSeconds === "number" ? ` (waited ${u.waitedSeconds}s)` : ""}: connected to you.`);
      else if (u.inbound) setNotice(`Inbound call${u.from ? ` from ${u.from.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}` : ""}: connected to you.`);
      if (u.survey && u.status === "ended") setNotice("You left the call; the caller is taking the post-call survey.");
      if (u.leadId) {
        // Ratio mode: the lead arrives with the live call.
        void leadById(u.leadId).then((l) => l && showLead(l));
      }
      if (u.status === "bridged" || u.status === "answered") setCallStart((s) => s ?? Date.now());
      if (u.status === "ended") {
        setHeld(false);
        setTargets(null);
        setScreener(null);
        setScreenerStep("say");
        setXferMenu(false);
        setTransfer(null);
        void refreshStats();
      }
    });
    return () => {
      clearTimeout(announce);
      sock.disconnect();
      setSock(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineUrl, rtToken, me.id]);

  // Team leaders: who is on my team; floor:agent events keep their live state fresh.
  useEffect(() => {
    if (!isLeader) return;
    const t = setTimeout(() => void myTeams().then(setTeams), 0);
    return () => clearTimeout(t);
  }, [isLeader]);

  // The agent's state, for the phone channel's handlers (they outlive renders).
  useEffect(() => {
    agentStateRef.current = agent?.state ?? "LOGGED_OUT";
  }, [agent?.state]);

  /** A call is up on this window's phone: the room line, or any other call (a supervision leg) on the client. */
  const phoneBusy = useCallback(() => Boolean(roomCallRef.current) || (clientRef.current?.callCount ?? 0) > 0 || (pendingClientRef.current?.callCount ?? 0) > 0, []);

  /** Hang up the line, disconnect every client this window made, and let go of the lock. */
  const teardownPhone = useCallback(() => {
    phoneGenRef.current += 1;
    const room = roomCallRef.current;
    roomCallRef.current = null;
    room?.hangup();
    for (const c of [clientRef.current, pendingClientRef.current]) {
      try {
        c?.disconnect();
      } catch {
        /* already gone */
      }
    }
    clientRef.current = null;
    pendingClientRef.current = null;
    connectingRef.current = false;
    setLine("down");
    setMuted(false);
    if (holdingRef.current) {
      holdingRef.current = false;
      postPhone(phoneChanRef.current, { t: "free", from: tabIdRef.current, kind: "console" });
    }
  }, []);

  // The phone channel between this agent's windows in this browser (lib/phone-lock.ts).
  useEffect(() => {
    if (screen !== "main" || typeof BroadcastChannel === "undefined") return;
    tabIdRef.current = newTabId();
    const chan = new BroadcastChannel(phoneChannelName(me.id));
    phoneChanRef.current = chan;
    const onMsg = (e: MessageEvent<PhoneMsg>) => {
      const m = e.data;
      if (!m || m.from === tabIdRef.current) return;
      if (m.t === "who" && holdingRef.current) postPhone(chan, { t: "mine", from: tabIdRef.current, kind: "console" });
      if (m.t === "release" && holdingRef.current) {
        // Never hand the phone over in the middle of a call or its wrap-up: the customer would be dropped.
        const st = agentStateRef.current;
        if (st === "ON_CALL" || st === "WRAP_UP" || (clientRef.current?.callCount ?? 0) > (roomCallRef.current ? 1 : 0)) {
          postPhone(chan, { t: "busy", from: tabIdRef.current, kind: "console" });
          return;
        }
        holdingRef.current = false;
        teardownPhone();
        setReg("off");
        setPhoneElsewhere("idle");
        postPhone(chan, { t: "released", from: tabIdRef.current, kind: "console" });
      }
    };
    chan.addEventListener("message", onMsg);
    return () => {
      chan.removeEventListener("message", onMsg);
      if (holdingRef.current) postPhone(chan, { t: "free", from: tabIdRef.current, kind: "console" });
      chan.close();
      phoneChanRef.current = null;
    };
  }, [screen, me.id, teardownPhone]);

  // Softphone: register once; the nailed-up leg is raised when the agent goes Ready.
  // Only the main window owns the phone (5 Nov: the assist pop-up raised its own line, the engine hung up the main
  // window's, and the pop-up's audio was blocked by the browser, so calls went silent).
  const connectPhone = useCallback(async (takeOver = false) => {
    if (!hasSip || screen !== "main") return;
    // One client per window, ever: not while one exists, is connecting, or another connectPhone() is in flight.
    if (clientRef.current || pendingClientRef.current || connectingRef.current) return;
    connectingRef.current = true;
    const gen = phoneGenRef.current;
    const where = `(registering ${sipUser}@${sipRealm || "(no realm)"} via ${sipServer})`;
    try {
      const chan = phoneChanRef.current;
      if (chan && !holdingRef.current) {
        // Does another window hold the phone? Wait briefly for an answer.
        const answer = await askPhoneChannel(chan, tabIdRef.current, { takeOver, kind: "console" });
        if (gen !== phoneGenRef.current) return;
        if (answer !== "free") {
          setPhoneElsewhere(answer === "busy" ? "busy" : "idle");
          setReg("off");
          return;
        }
      }
      // Claim the lock before connecting: from here this window answers "mine".
      holdingRef.current = true;
      setPhoneElsewhere(false);
      setReg("connecting");
      setPhoneError(null);
      const client = createJambonzClient({ server: sipServer, username: sipUser, password: sipPassword, realm: sipRealm || undefined, displayName: me.name });
      pendingClientRef.current = client;
      // Every handler is bound to this client: a late event from an old one never touches the new phone.
      const mine = () => clientRef.current === client || pendingClientRef.current === client;
      client.on("registered", () => {
        if (!mine()) return;
        phoneAutoRetriedRef.current = false;
        setReg("registered");
        setPhoneError(null);
      });
      client.on("registrationFailed", (e: Error) => {
        if (!mine()) return;
        setReg("error");
        setPhoneError(`${e.message} ${where}`);
      });
      client.on("disconnected", () => {
        if (clientRef.current !== client) return;
        setReg("off");
      });
      client.on("error", (e: Error) => {
        if (mine()) setPhoneError(e.message);
      });
      // The only thing that rings an agent's softphone is a supervision leg the engine placed for them (a team
      // leader listening in from My Team): answered only within 30 s of asking for it, and never with the line up.
      client.on("incoming", (call: { answer: () => void; hangup?: () => void }) => {
        const asked = pendingSupervisionAtRef.current;
        if (!mine() || roomCallRef.current || !asked || Date.now() - asked > SUPERVISION_ANSWER_WINDOW_MS) {
          call.hangup?.();
          return;
        }
        pendingSupervisionAtRef.current = 0;
        call.answer();
      });
      await withTimeout(client.connect(), 15_000, "Softphone registration");
      if (gen !== phoneGenRef.current || pendingClientRef.current !== client) {
        client.disconnect();
        return;
      }
      pendingClientRef.current = null;
      clientRef.current = client;
      phoneAutoRetriedRef.current = false;
      setReg("registered");
    } catch (e) {
      const failed = pendingClientRef.current;
      pendingClientRef.current = null;
      try {
        failed?.disconnect();
      } catch {
        /* never connected */
      }
      if (gen === phoneGenRef.current) {
        setReg("error");
        setPhoneError(`${e instanceof Error ? e.message : String(e)} ${where}`);
      }
    } finally {
      // A teardown meanwhile already cleared it, and a newer connect may be in flight: leave that one's flag alone.
      if (gen === phoneGenRef.current) connectingRef.current = false;
    }
  }, [hasSip, sipServer, sipUser, sipPassword, sipRealm, me.name, screen]);

  // Tear down whatever client exists (a failed registration may still hold one) and register afresh. Never with a
  // call on the phone: disconnect() hangs up every call on the client, the customer's included (7 Nov review).
  const retryPhone = useCallback(() => {
    if (!hasSip) return;
    if (phoneBusy()) {
      setNotice("Your line is up, so the phone was not re-registered. Finish the call, then click Reconnect line.");
      return;
    }
    const old = clientRef.current;
    clientRef.current = null;
    try {
      old?.disconnect();
    } catch {
      /* gone */
    }
    setPhoneError(null);
    void connectPhone();
  }, [hasSip, connectPhone, phoneBusy]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (hasSip) void connectPhone();
    }, 0);
    return () => {
      clearTimeout(t);
      teardownPhone();
      phoneAutoRetriedRef.current = false;
    };
  }, [hasSip, connectPhone, teardownPhone]);

  // After a registration failure retry once, 10 s later; further retries are the agent's click. Never while the
  // line is up or any call is on the client (the retry would hang them up).
  useEffect(() => {
    if (reg !== "error" || line !== "down" || phoneAutoRetriedRef.current) return;
    const t = setTimeout(() => {
      if (phoneBusy()) return;
      phoneAutoRetriedRef.current = true;
      retryPhone();
    }, 10_000);
    return () => clearTimeout(t);
  }, [reg, line, retryPhone, phoneBusy]);

  const raiseLine = useCallback(async () => {
    const client = clientRef.current;
    if (screen !== "main") throw new Error("Go Ready from the main console window: this window has no phone");
    if (!client || !hasSip) throw new Error("Softphone is not registered");
    if (roomCallRef.current) return;
    const call = sipAppSid ? client.callApplication(sipAppSid) : client.call("ready");
    roomCallRef.current = call;
    const startedAt = Date.now();
    setLine("raising");
    setMuted(false);
    setLineRefused(false);
    // The engine refuses a second line while the agent's first is alive (another window or device): the leg is
    // rejected or hung up at once. A local failure (no microphone, WebRTC) is not that.
    const quick = () => Date.now() - startedAt < 3_000;
    call.on("accepted", () => {
      if (roomCallRef.current === call) setLine("up");
    });
    call.on("ended", () => {
      if (roomCallRef.current !== call) return; // dropLine() / teardown already let go of it
      roomCallRef.current = null;
      setLine("down");
      setMuted(false);
      if (quick()) setLineRefused(true);
    });
    call.on("failed", (e: { code?: number; reason?: string }) => {
      if (roomCallRef.current !== call) return;
      roomCallRef.current = null;
      setLine("down");
      setMuted(false);
      const local = ["User Denied Media Access", "WebRTC Error", "Bad Media Description", "Missing SDP", "Connection Error", "Internal Error", "Canceled"].includes(e.reason ?? "");
      if (quick() && !local) setLineRefused(true);
      else setNotice(`Line failed: ${e.reason ?? e.code ?? "unknown"}`);
    });
    call.on("mute", (m: boolean) => {
      if (roomCallRef.current === call) setMuted(m);
    });
  }, [hasSip, sipAppSid, screen]);

  const dropLine = useCallback(() => {
    const call = roomCallRef.current;
    roomCallRef.current = null;
    setLine("down");
    setMuted(false);
    call?.hangup();
    return call;
  }, []);

  /**
   * Reconnect line: hang up this window's leg, wait for it to end (2 s at most), and raise a fresh one; with the
   * registration in error, register afresh first. Only between calls (the button is hidden on a call and in wrap-up).
   */
  const reconnectLine = async () => {
    if (agent?.state === "ON_CALL" || agent?.state === "WRAP_UP") {
      setNotice("Finish the call, then click Reconnect line.");
      return;
    }
    setReconnecting(true);
    setNotice(null);
    try {
      const old = dropLine();
      if (old && old.state !== "ended") {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          const done = () => {
            clearTimeout(t);
            resolve();
          };
          old.on("ended", done);
          old.on("failed", done);
        });
      }
      if (reg !== "registered" || !clientRef.current) {
        const stale = clientRef.current;
        clientRef.current = null;
        try {
          stale?.disconnect();
        } catch {
          /* gone */
        }
        await connectPhone();
      }
      if (!clientRef.current) throw new Error("the softphone did not register");
      await raiseLine();
      setNotice("Line reconnected.");
    } catch (e) {
      setNotice(`Line not reconnected: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReconnecting(false);
    }
  };

  /** "Use the phone here" after the engine refused this window's line: the engine ends the other one, this raises ours. */
  const takeLineHere = () =>
    run(async () => {
      const r = await lineTakeover();
      if (!r.ok) throw new Error(r.error);
      setLineRefused(false);
      await raiseLine();
    });

  // The engine refused this agent's second line (engine contract, 7 Nov): another window or device has it.
  useEffect(() => {
    if (screen !== "main" || !sock) return;
    const onRefused = (p: { reason?: string }) => {
      if (!p || p.reason === "another-screen" || !p.reason) setLineRefused(true);
    };
    sock.on("agent:line-refused", onRefused);
    return () => {
      sock.off("agent:line-refused", onRefused);
    };
  }, [screen, sock]);

  // Remote audio relies on autoplay; a line raised without a click (the reload re-raise) can be refused by the
  // browser. The patched SDK says so with "jambonz-audio-blocked"; the red banner's click plays it.
  useEffect(() => {
    if (screen !== "main") return;
    const onBlocked = (e: Event) => setAudioBlocked((e as CustomEvent<unknown>).detail ? String((e as CustomEvent<unknown>).detail) : "blocked");
    window.addEventListener("jambonz-audio-blocked", onBlocked);
    return () => window.removeEventListener("jambonz-audio-blocked", onBlocked);
  }, [screen]);
  const unblockAudio = () => {
    void playAllAudio().then((ok) => {
      if (ok) setAudioBlocked(null);
      else setNotice("The browser still blocks the call audio: allow sound for this site (address bar → site settings), then click the banner again.");
    });
  };

  // A reload or a closed tab kills this browser's half of the line, but the engine still holds the old
  // leg as the agent's line, so the next call joins a room nobody hears (6 Nov: "I couldn't hear him").
  // Hang the leg up as the page goes away, and on load raise a fresh line whenever the engine says the
  // agent has one this page does not own (the engine hangs up the stale leg when the new one joins).
  useEffect(() => {
    if (screen !== "main") return;
    const bye = () => {
      roomCallRef.current?.hangup();
      if (holdingRef.current) postPhone(phoneChanRef.current, { t: "free", from: tabIdRef.current, kind: "console" });
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [screen]);
  const reraisedRef = useRef(false);
  useEffect(() => {
    if (screen !== "main" || phone !== "registered" || line !== "down" || reraisedRef.current) return;
    if (!agent?.agentCallSid || !["READY", "PAUSED", "ON_CALL", "WRAP_UP"].includes(agent.state)) return;
    reraisedRef.current = true;
    // Mid-call, a fresh line would end the old room and drop the lead: say so instead of reconnecting.
    if (agent.state === "ON_CALL" || agent.state === "WRAP_UP") {
      const t = setTimeout(() => setNotice("The page reloaded, so your headset is no longer on this call. Disposition it, then click Reconnect line."), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setNotice("Reconnecting your line after the page reload…");
      raiseLine()
        .then(() => setNotice("Line reconnected."))
        .catch((e: unknown) => setNotice(`Line not reconnected: ${e instanceof Error ? e.message : String(e)}. Click Reconnect line.`));
    }, 0);
    return () => clearTimeout(t);
  }, [screen, phone, line, agent?.agentCallSid, agent?.state, raiseLine]);

  // Actions
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Server Action ids from a previous build: the page is stale, not the action.
      if (isStaleBuildError(message)) markStale();
      else setNotice(message);
    } finally {
      setBusy(false);
    }
  };

  const login = () => {
    if (twoScreen) openAssist();
    return run(async () => {
      if (!campaignId) throw new Error("Pick a campaign");
      const r = await agentLogin(campaignId);
      if (!r.ok) throw new Error(r.error);
      setAgent(r.agent);
    });
  };

  const goReady = () =>
    run(async () => {
      if (!agent) throw new Error("Log in first");
      // Ask for Ready first: with the line already up the agent is Ready now; without it the engine makes them
      // Ready the moment the line joins. Agents log in paused (owner, 6 Nov), so the line alone never readies them.
      const r = await agentSetState("READY");
      if (!r.ok) throw new Error(r.error);
      setAgent(r.agent);
      await raiseLine();
    });

  const pause = (reason: string) =>
    run(async () => {
      setPauseMenu(null);
      const r = await agentSetState("PAUSED", reason);
      if (!r.ok) throw new Error(r.error);
    });

  const logout = () =>
    run(async () => {
      // The engine refuses while the agent is on a call ({ ok: false, error }): the line stays up, the reason shows.
      const r = await agentLogout();
      if (!r.ok) throw new Error(r.error);
      dropLine();
      setAgent(null);
      setLead(null);
      setCallId(null);
      setCallStatus("idle");
    });

  const fetchNext = () =>
    run(async () => {
      const r = await nextLead();
      if (!r.ok) throw new Error(r.error);
      showLead(r.lead);
    });

  const skip = () =>
    run(async () => {
      if (lead) await skipLead(lead.id);
      setLead(null);
    });

  const dial = () =>
    run(async () => {
      if (!lead) return;
      const r = await dialLead(lead.id);
      if (!r.ok) throw new Error(r.error);
      setCallId(r.callId);
      setCallStatus("dialing");
      setCallStart(null);
    });

  /**
   * End Call. With a transfer live it ends the call for everyone (the lead
   * hanging up drops the destination), so it asks first; after the agent has
   * left a transfer the lead is no longer theirs to hang up.
   */
  const endCall = () =>
    run(async () => {
      if (!callId) return;
      if (transfer?.agentLeftAt) throw new Error("You already left: the lead and the destination are talking. Disposition below.");
      if (transfer && transfer.state !== "ended" && !window.confirm(`End the call for everyone? The lead and ${transfer.destinationName} will both be hung up. To drop off and keep them talking, use Leave call instead.`)) return;
      await hangup(callId);
    });

  const send = () =>
    run(async () => {
      if (!lead || !draft.trim()) return;
      const r = await sendText(lead.id, draft.trim());
      if (!r.ok) throw new Error(r.error);
      setDraft("");
      setThread(await textThread(lead.id));
    });

  const toggleHold = () =>
    run(async () => {
      if (!callId) return;
      const r = await holdCall(callId, !held);
      if (!r.ok) throw new Error(r.error);
      setHeld(!held);
    });

  /** The Transfer dropdown: the campaign's destinations at once, the closers free right now once looked up. */
  const openXferMenu = () =>
    run(async () => {
      setXferMenu(true);
      setTargets(await transferTargets(campaignId || null));
    });
  const closeXferMenu = () => {
    setXferMenu(false);
    setTargets(null);
  };

  const doTransfer = (toAgentId: string) =>
    run(async () => {
      if (!callId) return;
      const r = await transferCall(callId, toAgentId);
      if (!r.ok) throw new Error(r.error);
      closeXferMenu();
      setNotice("Transferred. Disposition your part of the call.");
    });

  /**
   * Dial a destination. The transfer shows at once ("Calling …" with a ring
   * timer) instead of waiting for the engine's ringing event: on 5 Nov the
   * console looked idle for a second, the agent clicked again and hit Cancel.
   */
  const startTransfer = (d: ConsoleProps["campaigns"][number]["transferDestinations"][number]) =>
    run(async () => {
      if (!callId) return;
      const mode = xferModes[d.id] ?? d.type;
      closeXferMenu();
      setXferStartedAt(Date.now());
      setTransfer({ id: "pending", state: "ringing", destinationName: d.name, destinationId: d.id, mode, callerIdShown: null, callerIdFallback: false, answeredAt: null, agentLeftAt: null });
      const r = await transferToDestination(callId, d.id, mode);
      if (!r.ok) {
        setTransfer((cur) => (cur?.id === "pending" ? null : cur));
        throw new Error(r.error);
      }
      setTransfer((cur) => (cur?.id === "pending" ? { ...cur, id: r.transferId } : cur));
    });
  const leaveTransfer = () =>
    run(async () => {
      if (!callId) return;
      const r = await transferLeave(callId);
      if (!r.ok) throw new Error(r.error);
    });
  const cancelXfer = () =>
    run(async () => {
      if (!callId) return;
      const r = await transferCancel(callId);
      if (!r.ok) throw new Error(r.error);
    });

  const dialManual = () =>
    run(async () => {
      if (!manual.trim()) return;
      const r = await manualDial(manual.trim());
      if (!r.ok) throw new Error(r.error);
      setManual("");
      setCallId(r.callId);
      setCallStatus("dialing");
      setCallStart(null);
      const cur = await agentCurrent();
      if (cur?.reservedLeadId) {
        const l = await leadById(cur.reservedLeadId);
        if (l) showLead(l);
      }
    });

  const dropVoicemail = () =>
    run(async () => {
      if (!callId) return;
      const r = await leaveVoicemail(callId);
      if (!r.ok) throw new Error(r.error);
      setNotice("Voicemail is being left; you are back to Ready.");
      setLead(null);
      setCallId(null);
      setCallStatus("idle");
      setCallStart(null);
      void refreshStats();
    });

  const toggleMute = () => {
    const c = roomCallRef.current;
    if (!c) return;
    c.toggleMute();
  };

  /**
   * Save edits from the Lead card. Autosave calls this, so it takes no busy
   * flag (the agent's next click is never blocked) and leaves the notes box
   * alone (it saves itself); a failure shows as a notice.
   */
  const saveLead = async (fields: LeadEdit) => {
    if (!lead) return;
    const id = lead.id;
    try {
      const r = await updateLead(id, fields);
      if (!r.ok) throw new Error(r.error);
      setLead((cur) => (cur && cur.id === id ? { ...r.lead, notes: cur.notes } : cur));
      void leadHistory(id).then(setHistory);
    } catch (e) {
      setNotice(`Lead not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Supervisors flag the lead on screen VIP: it jumps inbound queues by the queue's VIP points. */
  const toggleVip = async () => {
    if (!lead) return;
    const id = lead.id;
    try {
      const r = await setLeadVip(id, !lead.vip);
      if (!r.ok) throw new Error(r.error);
      setLead((cur) => (cur && cur.id === id ? { ...cur, vip: r.lead.vip } : cur));
      void leadHistory(id).then(setHistory);
    } catch (e) {
      setNotice(`VIP not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Notes auto-save when the agent leaves the box; no busy flag so the next click is not lost. */
  const saveNotes = () => {
    if (!lead || notes.trim() === (lead.notes ?? "").trim()) return;
    const id = lead.id;
    void updateLead(id, { notes })
      .then((r) => {
        if (!r.ok) throw new Error(r.error);
        setLead((cur) => (cur && cur.id === id ? { ...cur, notes: r.lead.notes } : cur));
        void leadHistory(id).then(setHistory);
      })
      .catch((e: unknown) => setNotice(`Notes not saved: ${e instanceof Error ? e.message : String(e)}`));
  };
  // Notes also save a second after typing stops, not only on leaving the box (read through a ref: the clock re-renders every second).
  const saveNotesRef = useRef(saveNotes);
  useEffect(() => {
    saveNotesRef.current = saveNotes;
  });
  useEffect(() => {
    const t = setTimeout(() => saveNotesRef.current(), 1000);
    return () => clearTimeout(t);
  }, [notes]);

  /**
   * Send the disposition. On a live call the call is hung up first and the
   * disposition follows, so one click (or hotkey) does both. `dispositionId`
   * absent = callback via the campaign's callback disposition (engine creates
   * a default "Callback" when the campaign has none).
   */
  const sendDisposition = (dispositionId: string | undefined, callback?: { at?: string; inMinutes?: number }) =>
    run(async () => {
      if (!callId) throw new Error("No call to disposition");
      // A disposition hangs the call up first. Never on a live transfer: it would end the three-way, or,
      // after Leave, cut off the lead and the destination the agent just connected.
      if (transfer && !transfer.agentLeftAt && transfer.state !== "ended") throw new Error("A transfer is live: use Leave call (they stay connected) or End call for everyone first");
      if (agent?.state === "ON_CALL" && !transfer?.agentLeftAt) await hangup(callId);
      const r = await disposition({ callId, dispositionId, notes: notes || undefined, callbackAt: callback?.at, callbackInMinutes: callback?.inMinutes, callbackScope: callback ? "AGENT" : undefined });
      if (!r.ok) throw new Error(r.error);
      dispositionedRef.current = callId;
      if (lead && notes.trim() !== (lead.notes ?? "").trim()) await updateLead(lead.id, { notes });
      setLead(null);
      setCallId(null);
      setCallStatus("idle");
      setCallStart(null);
      setHeld(false);
      setTargets(null);
      setAiNote(null);
      setScreener(null);
      setScreenerStep("say");
      setXferMenu(false);
      setTransfer(null);
      setNotes("");
      setCallbackAt("");
      setScheduling(false);
      void refreshStats();
    });

  /** The campaign's callback disposition, if it has one; otherwise the engine makes a default "Callback". */
  const callbackDispositionId = campaign?.dispositions.find((d) => d.isCallback)?.id;

  /** Callback any time: lead back for this agent, due now + the campaign's callbackOwnerMinutes (60 when unset). */
  const callbackNow = () => sendDisposition(callbackDispositionId, { inMinutes: campaign?.callbackOwnerMinutes || 60 });

  const dispo = (d: ConsoleProps["campaigns"][number]["dispositions"][number]) => (d.isCallback ? callbackNow() : sendDisposition(d.id));

  /** Scheduled callback: Submit from the picker. */
  const callbackScheduled = () => {
    if (!callbackAt) {
      setNotice("Pick a callback date and time");
      return Promise.resolve();
    }
    return sendDisposition(callbackDispositionId, { at: new Date(callbackAt).toISOString() });
  };

  // Hotkeys for dispositions, on the call and during wrap-up. A campaign callback
  // disposition's hotkey opens the scheduled-callback picker (submits it when a time is set).
  useEffect(() => {
    if (!campaign || !callId || (agent?.state !== "WRAP_UP" && agent?.state !== "ON_CALL")) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const d = campaign.dispositions.find((x) => x.hotkey === e.key);
      if (!d) return;
      if (d.isCallback) {
        if (scheduling && callbackAt) void callbackScheduled();
        else setScheduling(true);
      } else void sendDisposition(d.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign, agent?.state, callId, notes, callbackAt, scheduling]);

  const state = agent?.state ?? "LOGGED_OUT";
  const onCall = state === "ON_CALL";
  const wrapUp = state === "WRAP_UP";
  const ready = state === "READY";
  const lineUpIdle = (state === "READY" || state === "PAUSED") && Boolean(agent?.agentCallSid);
  // Reconnect line: between calls, when this window's line is up, the phone is in error, or the engine still
  // has a line for the agent that this window does not (a reload mid-call).
  const showReconnect = screen === "main" && hasSip && !phoneElsewhere && Boolean(agent) && !onCall && !wrapUp && (line === "up" || reg === "error" || (line === "down" && Boolean(agent?.agentCallSid)));
  // Games: one overview for the purse, the panel and the deal moment (games.tsx).
  const games = useGames({ campaignId, socket: sock, meId: me.id, enabled: can("games"), onCall });
  // One-way audio (7 Nov): the browser's own numbers say which side went quiet, on screen and in the web log.
  useAudioWatchdog({
    callRef: roomCallRef,
    active: onCall && screen === "main",
    callId,
    onProblem: (kind, message, detail) => {
      setNotice(message);
      if (callId) void reportAudioProblem(callId, kind, detail).catch(() => undefined);
    },
  });
  const canDialOut = campaign ? campaign.agentMode !== "CLOSER" || (campaign.closersMayDial && campaign.outboundOn) : false;

  // Screener banner steps. "Say it" gives way to "stay quiet" after 5 s (or the Said it click);
  // "They picked up" comes from the engine (AMD hears a human after the screener) or, failing a
  // signal, 25 s into the quiet step: by then the screen has played the message and the person
  // has either picked up or hung up on us (the call:update "ended" clears the banner).
  useEffect(() => {
    if (!screener || !onCall) return;
    if (screenerStep === "say") {
      const t = setTimeout(() => setScreenerStep("wait"), 5_000);
      return () => clearTimeout(t);
    }
    if (screenerStep === "wait") {
      const t = setTimeout(() => setScreenerStep("go"), 25_000);
      return () => clearTimeout(t);
    }
  }, [screener, screenerStep, onCall]);

  const saidIt = () => {
    setScreenerStep("wait");
    if (callId) void screenerSaidIt(callId);
  };
  const screenerLine = renderScript(campaign?.screenerScript || DEFAULT_SCREENER_SCRIPT, { agentName: me.name, company: me.tenant, lead });
  const screenerBanner =
    onCall && screener ? (
      <div className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-400/15 p-4 shadow-[0_0_32px_rgba(251,191,36,0.35)]" role="alert">
        <div className="flex items-start justify-between gap-3">
          <div className="text-4xl font-black tracking-[0.2em] text-amber-300">SCREENER</div>
          {screener.phrase ? (
            <div className="max-w-[45%] truncate pt-2 text-xs text-amber-200/70" title={screener.phrase}>
              heard: “{screener.phrase}”
            </div>
          ) : null}
        </div>
        {screenerStep === "go" ? (
          <div className="mt-3 flex items-center gap-3 text-2xl font-bold text-emerald-300">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-400 text-base text-emerald-950">✓</span>
            They picked up. Go.
          </div>
        ) : (
          <>
            <div className="mt-2 text-sm font-medium text-amber-100">Their phone is screening the call. Say this, then stop talking:</div>
            <div className="mt-2 rounded-xl bg-black/40 px-4 py-3 text-2xl font-semibold leading-snug text-white">{screenerLine}</div>
            {screenerStep === "say" ? (
              <button onClick={saidIt} className="mt-3 rounded-lg bg-amber-400 px-4 py-2 font-semibold text-amber-950 hover:bg-amber-300">
                Said it
              </button>
            ) : (
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-base text-zinc-100">
                <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-amber-300" aria-hidden />
                <span>Now stay quiet. Don&apos;t say anything else until the person picks up. The screen may play your message to them.</span>
              </div>
            )}
          </>
        )}
      </div>
    ) : null;

  const aiPanel =
    callId && aiNote ? (
      <div className="mb-4 rounded-xl border border-violet-400/50 bg-violet-500/10 p-3" role="status">
        <div className="text-sm text-violet-100">
          <span className="font-semibold text-violet-300">AI summary: </span>
          {aiNote.summary || "The automated assistant spoke with this caller first."}
        </div>
        {aiNote.transcript.length ? (
          <details className="mt-1 text-xs text-zinc-300">
            <summary className="cursor-pointer select-none text-violet-300/80">What was said ({aiNote.transcript.length})</summary>
            <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
              {aiNote.transcript.map((t, i) => (
                <div key={i}>
                  <span className={t.role === "caller" ? "text-sky-300" : "text-violet-300"}>{t.role === "caller" ? "Caller" : "AI"}:</span> {t.text}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    ) : null;

  const banner =
    state === "LOGGED_OUT"
      ? { label: "OFFLINE", sub: "Pick a campaign and log in", color: "#8b8f9a" }
      : state === "LOGGED_IN"
        ? { label: "LOGGED IN", sub: phone === "registered" ? "click to go Ready" : phone === "connecting" ? "Registering softphone…" : phone === "error" ? <button type="button" onClick={retryPhone} title="Click to re-register the softphone" className="text-left text-red-300 underline decoration-dotted underline-offset-2 hover:text-red-200">Softphone error: {phoneError} · click to retry</button> : "Softphone offline", color: "#f5c452" }
        : state === "READY"
          ? { label: "READY", sub: `${campaign?.dialMode === "PREVIEW" ? "Preview mode · pull the next lead when you are" : "Waiting for Live Call"} · click to pause`, color: "#3ddc97" }
          : state === "PAUSED"
            ? { label: "PAUSED", sub: `${agent?.pauseReason ?? "On break"} · ${agent?.agentCallSid ? "click to go Ready" : phone === "registered" ? "click to bring your line up and go Ready" : phone === "connecting" ? "registering softphone…" : "softphone offline"}`, color: "#f5c452" }
            : state === "ON_CALL"
              ? screener
                ? { label: "SCREENER", sub: screenerStep === "go" ? "They picked up: go" : screenerStep === "say" ? "Their phone is screening: read the script" : "Stay quiet until they pick up", color: "#fbbf24" }
                : { label: "ON CALL", sub: callStatus === "dialing" ? "Dialing…" : callStatus === "answered" ? "Answered · connecting" : "Live", color: "#5ab4ff" }
              : { label: "WRAP-UP", sub: "Disposition the call", color: "#c084fc" };

  // The banner is the primary Ready/Pause control. ON_CALL and WRAP_UP are not clickable,
  // nor is LOGGED_IN until the softphone has registered (its error text carries its own retry button).
  const bannerActionLabel =
    state === "READY"
      ? "Ready. Click to pause and pick a reason"
      : state === "PAUSED"
        ? `Paused (${agent?.pauseReason ?? "On break"}). Click to resume and go Ready`
        : state === "LOGGED_IN" && phone === "registered"
          ? "Logged in. Click to go Ready and bring your line up"
          : null;
  const bannerClick = () => {
    if (state === "READY") setPauseMenu((m) => (m === "banner" ? null : "banner"));
    else if (state === "PAUSED" || state === "LOGGED_IN") goReady();
  };
  const bannerClass = "mb-5 flex items-center justify-center gap-6 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-6 py-5";
  const bannerBody = (
    <>
      <Waveform colors={["#a855f7", "#ec4899"]} className="hidden md:flex" />
      <div className="text-center">
        <div className="text-3xl font-bold tracking-tight">
          <span style={{ color: banner.color }}>{banner.label}</span>
          <span className="text-zinc-500"> • </span>
          <span>{onCall ? timer : state === "LOGGED_OUT" ? "Strowger" : banner.label === "READY" ? "Waiting for Live Call" : stateSince}</span>
        </div>
        <div className="mt-1 text-sm text-zinc-400">
          {campaign ? `${campaign.name} · ` : ""}
          {banner.sub}
        </div>
      </div>
      <Waveform colors={["#22d3ee", "#3b82f6"]} className="hidden md:flex" />
    </>
  );

  const leadName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown name" : "";
  const localTime = leadLocalTime(lead, now);
  const leadCard = lead ? (
    <LeadCardEditor key={lead.id} lead={lead} notes={notes} onNotes={setNotes} onNotesBlur={saveNotes} onSave={saveLead} busy={busy} now={now} right={
        <span className="flex items-center gap-2">
          {canVip ? (
            <button type="button" onClick={() => void toggleVip()} title="VIP callers jump the inbound queue" className={`rounded px-1.5 py-0.5 text-xs ${lead.vip ? "bg-amber-400/20 text-amber-200" : "border border-white/10 text-zinc-400 hover:bg-white/10"}`}>
              {lead.vip ? "★ VIP" : "☆ VIP"}
            </button>
          ) : lead.vip ? (
            <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-xs text-amber-200">★ VIP</span>
          ) : null}
          <span className="text-xs text-zinc-500">{onCall ? "on call" : wrapUp ? "wrap-up" : "on screen"}</span>
        </span>
      }
    />
  ) : null;

  return (
    <div className="flex min-h-screen">
      <style>{`@keyframes sw-pulse{0%,100%{transform:scaleY(.35);opacity:.5}50%{transform:scaleY(1);opacity:1}}`}</style>

      {/* Rail */}
      <aside className="flex w-16 flex-col items-center gap-3 border-r border-white/10 bg-black/20 py-4">
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-lg font-black text-white">S</div>
        {/* A window stays what it was opened as: the main window keeps the phone, the second screen never gets one.
            (Switching a window between the two used to move or drop the phone mid-shift.) */}
        <span title={screen === "main" ? "Console (this window has the phone)" : "Second screen (no phone)"} className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 text-lg text-cyan-300">
          {screen === "main" ? "⌂" : "▦"}
        </span>
        {screen === "main" ? (
          <button onClick={openAssist} title="Open the assist screen in a second window (drag it to your other monitor)" className="grid h-10 w-10 place-items-center rounded-xl text-lg text-zinc-400 hover:bg-white/10">
            ⧉
          </button>
        ) : null}
        <div className="flex-1" />
        <a href="/dashboard" title="Back to dashboard" className="grid h-10 w-10 place-items-center rounded-xl text-zinc-400 hover:bg-white/10">
          ⎋
        </a>
      </aside>

      <main className="flex-1 p-5">
        {/* Top bar */}
        <div className="mb-4 flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={Boolean(agent)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-zinc-100 disabled:opacity-60">
              {campaigns.length === 0 ? <option value="">No active campaigns assigned</option> : null}
              {campaigns.map((c) => (
                <option key={c.id} value={c.id} className="bg-zinc-900">
                  {c.name} · {c.dialMode === "RATIO" ? "ratio" : "preview"} · {c.agentMode.toLowerCase()}
                </option>
              ))}
            </select>
            {sip && screen === "main" && phoneElsewhere ? (
              <button type="button" onClick={() => void connectPhone(true)} title="Another console window in this browser has your phone. Click to hang it up there and use it here." className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-500/30">
                {phoneElsewhere === "busy" ? "Your phone is on a call in another window — finish it there" : "phone is in another window · use it here"}
              </button>
            ) : screen !== "main" ? null : sip && phone === "error" ? (
              <button type="button" onClick={retryPhone} title={`${phoneError ?? "Softphone error"} — click to retry`} className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/30">
                phone error · retry
              </button>
            ) : (
              <span className={`rounded-full px-2 py-0.5 text-xs ${phone === "in-room" ? "bg-emerald-500/20 text-emerald-300" : phone === "registered" ? "bg-sky-500/20 text-sky-300" : "bg-white/10 text-zinc-400"}`}>
                {sip ? (phone === "in-room" ? "line up" : line === "raising" ? "line connecting…" : phone === "registered" ? "phone registered" : phone === "connecting" ? "registering…" : "phone offline") : "no softphone line issued"}
              </span>
            )}
            {showReconnect ? (
              <button type="button" onClick={() => void reconnectLine()} disabled={reconnecting || busy} title="Hang up your line and bring a fresh one up (between calls only)" className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50">
                {reconnecting ? "reconnecting…" : "Reconnect line"}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {billing && !billing.isPlatform && (billing.suspended || billing.critical || billing.low) ? (
              <span className={`mr-2 rounded-md border px-2 py-1 text-xs ${billing.suspended || billing.critical ? "border-red-500/50 bg-red-950/60 text-red-200" : "border-amber-500/50 bg-amber-950/60 text-amber-200"}`}>
                {billing.suspended ? "Outbound paused: prepaid balance used up" : billing.critical ? `Balance used up: outbound pauses in ${billing.graceDays} days` : `Low prepaid balance: $${(billing.balanceCents / 100).toFixed(0)}`}
              </span>
            ) : null}
            {screen === "main" ? (
              <label className="mr-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-400" title="Open the assist screen in a second window every time you log in">
                <span>2 screens</span>
                <button onClick={toggleTwoScreen} className={`relative h-5 w-9 rounded-full transition ${twoScreen ? "bg-emerald-500" : "bg-zinc-700"}`} aria-pressed={twoScreen}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${twoScreen ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </label>
            ) : null}
            {screen !== "main" ? (
              // The second screen never touches the phone or the agent's state (owner, 7 Nov: "on that second screen it has
              // nothing to do with the telephony"). Its Log out used to hang up the line from the other monitor.
              <span className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400" title="Log in, Ready, Pause, Log out and the phone are on the main console window">
                Second screen · {agent ? agent.state.toLowerCase().replace("_", " ") : "logged out"} · controls are on the main window
              </span>
            ) : !agent ? (
              <button onClick={login} disabled={busy || !campaignId} className="rounded-lg bg-white px-3 py-1.5 font-medium text-zinc-900 disabled:opacity-50">
                Log in
              </button>
            ) : (
              <>
                {!ready && !onCall && !wrapUp ? (
                  <button onClick={goReady} disabled={busy || phone === "off" || phone === "error"} className="rounded-lg bg-emerald-400 px-3 py-1.5 font-semibold text-emerald-950 disabled:opacity-50">
                    Go Ready
                  </button>
                ) : null}
                {ready ? (
                  <div className="relative">
                    <button onClick={() => setPauseMenu((m) => (m === "bar" ? null : "bar"))} disabled={busy} className="rounded-lg border border-white/15 px-3 py-1.5 text-zinc-200 hover:bg-white/10">
                      Pause…
                    </button>
                    {pauseMenu === "bar" ? (
                      <div className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
                        {PAUSE_REASONS.map((r) => (
                          <button key={r} onClick={() => pause(r)} className="block w-full px-3 py-2 text-left text-sm hover:bg-white/10">
                            {r}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button onClick={logout} disabled={busy || onCall} className="rounded-lg border border-white/15 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-50">
                  Log out
                </button>
              </>
            )}
            {can("games") ? (
              <div className="ml-2">
                <PointsPurse g={games} />
              </div>
            ) : null}
            <div className="ml-3 grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-xs font-bold">{me.name.slice(0, 1).toUpperCase()}</div>
          </div>
        </div>

        <NewVersionBanner show={newVersion} onCall={onCall || wrapUp} />
        {screen === "main" && audioBlocked ? (
          <button type="button" onClick={unblockAudio} role="alert" title={audioBlocked} className="mb-4 block w-full rounded-xl border-2 border-red-500 bg-red-600/30 px-4 py-3 text-left text-base font-semibold text-red-50 shadow-[0_0_24px_rgba(239,68,68,0.35)] hover:bg-red-600/40">
            Your browser blocked the call audio — click here to turn it on
          </button>
        ) : null}
        {screen === "main" && lineRefused ? (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-400 bg-amber-400/15 px-4 py-3 text-sm text-amber-50">
            <span className="flex-1 font-semibold">You already have a call screen open in another window or device.</span>
            <button type="button" onClick={takeLineHere} disabled={busy} className="rounded-lg bg-amber-400 px-3 py-1.5 font-semibold text-amber-950 hover:bg-amber-300 disabled:opacity-50">
              Use the phone here
            </button>
          </div>
        ) : null}
        {notice ? <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice}</div> : null}
        {can("games") ? <GamesLayer g={games} /> : null}

        {/* Status banner: the primary Ready / Pause control */}
        {bannerActionLabel ? (
          <div className="relative">
            <button
              type="button"
              onClick={bannerClick}
              disabled={busy}
              aria-label={bannerActionLabel}
              aria-expanded={state === "READY" ? pauseMenu === "banner" : undefined}
              title={bannerActionLabel}
              className={`${bannerClass} w-full cursor-pointer transition hover:border-white/25 hover:from-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:opacity-60`}
            >
              {bannerBody}
            </button>
            {pauseMenu === "banner" ? (
              <div className="absolute left-1/2 top-full z-10 -mt-3 w-44 -translate-x-1/2 overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
                <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">Pause reason</div>
                {PAUSE_REASONS.map((r) => (
                  <button key={r} type="button" onClick={() => pause(r)} className="block w-full px-3 py-2 text-left text-sm hover:bg-white/10">
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={bannerClass}>{bannerBody}</div>
        )}

        {screen === "main" ? (
          <div className="grid gap-4 xl:grid-cols-[320px_1fr_300px]">
            {/* Lead profile */}
            <div className="space-y-4">
              <Panel title="Lead Profile" right={lead ? <span className="text-xs text-zinc-500">{lead.attemptsTotal} attempts</span> : null}>
                {!lead ? (
                  <div className="space-y-3 text-sm text-zinc-400">
                    <p>{campaign?.dialMode === "PREVIEW" ? "No lead on screen." : "Leads arrive automatically when a live person answers."}</p>
                    {campaign?.dialMode === "PREVIEW" && ready && canDialOut ? (
                      <button onClick={fetchNext} disabled={busy} className="w-full rounded-lg bg-white/10 px-3 py-2 font-medium text-zinc-100 hover:bg-white/15 disabled:opacity-50">
                        Get next lead
                      </button>
                    ) : null}
                    {campaign && !canDialOut ? <p className="text-xs">You are a closer on this campaign: you receive transfers and callbacks.</p> : null}
                    {lineUpIdle && canDialOut ? (
                      <div className="flex gap-2">
                        <input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !ready && dialManual()} placeholder="Dial a number…" className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600" />
                        <button onClick={dialManual} disabled={busy || !manual.trim() || ready} title={ready ? "Pause first, then dial: while you are Ready the dialer can connect a call to you" : undefined} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
                          Dial
                        </button>
                      </div>
                    ) : null}
                    {lineUpIdle && canDialOut && ready ? <p className="text-xs text-zinc-500">Pause first, then dial: while you are Ready the dialer can connect a call to you.</p> : null}
                  </div>
                ) : (
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-3">
                      <div className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-500 text-base font-bold">{leadName.slice(0, 1).toUpperCase()}</div>
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold">{leadName}</div>
                        <div className="font-mono text-zinc-300">{formatPhone(lead.phone)}</div>
                        <div className="text-xs text-zinc-400">{localTime ? `Local time ${localTime}` : "Local time unknown"}</div>
                      </div>
                    </div>
                    <p className="text-xs text-zinc-500">Every field and your notes are on the Lead card in the middle.</p>
                    {ready && !callId && campaign?.dialMode === "PREVIEW" ? (
                      <div className="flex gap-2">
                        <button onClick={dial} disabled={busy || !canDialOut} className="flex-1 rounded-lg bg-emerald-400 px-3 py-2 font-semibold text-emerald-950 disabled:opacity-50">
                          Dial
                        </button>
                        <button onClick={skip} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-zinc-300 hover:bg-white/10">
                          Skip
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </Panel>
              {/* Dispositions under the lead profile (owner, 6 Nov): a smaller box on the left. On a live call a disposition hangs up first. */}
              {onCall || wrapUp ? (
                  <Panel title="Call Dispositions" collapsible={false} right={wrapUp ? <span className="rounded bg-fuchsia-500/20 px-1.5 text-xs text-fuchsia-200">wrap-up</span> : onCall ? <span className="text-xs text-zinc-500">ends the call</span> : null}>
                    {!campaign ? null : (
                      <div className="space-y-2">
                        {wrapUp && transfer?.agentLeftAt ? (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-violet-100">
                            <span>
                              Transferred to {transfer.destinationName} ({transfer.mode.toLowerCase()}){transfer.state === "ended" ? ", now finished" : ", still talking"}. Dispositioned &ldquo;{transfer.dispositionLabel ?? "Transferred"}&rdquo;: keep it, or pick another below.
                            </span>
                            <button onClick={() => transfer.dispositionId && sendDisposition(transfer.dispositionId)} disabled={busy || !transfer.dispositionId} className="rounded-lg bg-violet-400 px-3 py-1 text-xs font-semibold text-violet-950 disabled:opacity-40">
                              Keep &ldquo;{transfer.dispositionLabel ?? "Transferred"}&rdquo;
                            </button>
                          </div>
                        ) : null}
                        {wrapUp && live.suggestedDisposition && campaign.dispositions.some((d) => d.id === live.suggestedDisposition?.dispositionId) ? (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100">
                            <span className="flex-1">
                              Suggested: <b>{live.suggestedDisposition.label}</b>
                              {live.suggestedDisposition.reason ? ` · ${live.suggestedDisposition.reason}` : ""}
                            </span>
                            <button onClick={() => live.suggestedDisposition && sendDisposition(live.suggestedDisposition.dispositionId)} disabled={busy || !callId} className="rounded-lg bg-cyan-400 px-3 py-1 text-xs font-semibold text-cyan-950 disabled:opacity-40">
                              Confirm &ldquo;{live.suggestedDisposition.label}&rdquo;
                            </button>
                          </div>
                        ) : null}
                        {wrapUp && live.summary ? <p className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-zinc-300"><span className="text-zinc-500">AI summary (added to the lead&apos;s notes): </span>{live.summary}</p> : null}
                        <div className="grid grid-cols-2 gap-2">
                          {campaign.dispositions
                            .filter((d) => !d.isCallback)
                            .map((d) => (
                              <button
                                key={d.id}
                                onClick={() => dispo(d)}
                                disabled={busy || !callId}
                                className={`rounded-lg border px-2 py-2 text-left text-xs disabled:opacity-40 ${wrapUp && live.suggestedDisposition?.dispositionId === d.id ? "ring-2 ring-cyan-400 " : ""}${d.isSale ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : d.isDnc ? "border-red-400/40 bg-red-400/10 text-red-200" : "border-white/10 bg-white/5 text-zinc-200"} hover:bg-white/10`}
                              >
                                <div className="font-semibold">
                                  {d.label}
                                  {d.hotkey ? <span className="ml-1 rounded bg-black/30 px-1 font-mono text-[10px] text-zinc-400">{d.hotkey}</span> : null}
                                </div>
                                <div className="font-mono text-[10px] text-zinc-500">{d.code}</div>
                              </button>
                            ))}
                          <button onClick={callbackNow} disabled={busy || !callId} title={`Back to you, due in ${campaign.callbackOwnerMinutes || 60} min`} className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-2 py-2 text-left text-xs text-sky-200 hover:bg-white/10 disabled:opacity-40">
                            <div className="font-semibold">Callback</div>
                            <div className="font-mono text-[10px] text-zinc-500">any time · {campaign.callbackOwnerMinutes || 60} min</div>
                          </button>
                          <button onClick={() => setScheduling((v) => !v)} disabled={busy || !callId} className={`rounded-lg border px-2 py-2 text-left text-xs hover:bg-white/10 disabled:opacity-40 ${scheduling ? "border-sky-300 bg-sky-400/25 text-sky-100" : "border-sky-400/40 bg-sky-400/10 text-sky-200"}`}>
                            <div className="font-semibold">
                              Scheduled callback
                              {campaign.dispositions.find((d) => d.isCallback)?.hotkey ? <span className="ml-1 rounded bg-black/30 px-1 font-mono text-[10px] text-zinc-400">{campaign.dispositions.find((d) => d.isCallback)?.hotkey}</span> : null}
                            </div>
                            <div className="font-mono text-[10px] text-zinc-500">pick a date & time</div>
                          </button>
                        </div>
                        {scheduling ? (
                          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-sky-400/20 bg-black/30 p-3">
                            <label className="flex-1 text-xs text-zinc-400">
                              Callback time
                              <input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void callbackScheduled()} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-100" />
                            </label>
                            <button onClick={callbackScheduled} disabled={busy || !callId || !callbackAt} className="rounded-lg bg-sky-400 px-3 py-2 text-sm font-semibold text-sky-950 disabled:opacity-40">
                              Submit
                            </button>
                            <button onClick={() => { setScheduling(false); setCallbackAt(""); }} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-300 hover:bg-white/10">
                              Cancel
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </Panel>
              ) : null}
            </div>

            {/* Call in progress / waiting feed */}
            <div className="space-y-4">
              {onCall || wrapUp ? (
                <>
                <Panel title={onCall ? `Call in Progress • ${timer}` : "Call ended"} collapsible={false}>
                  {screenerBanner}
                  {aiPanel}
                  <div className="mb-4 flex items-center justify-center gap-4">
                    <Waveform colors={["#22d3ee", "#a855f7"]} />
                  </div>
                  <div className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm">
                    <div className="mb-2 text-xs uppercase tracking-wide text-emerald-300/80">Communication & Live Transcript</div>
                    {liveOn ? (
                      <div className="space-y-3">
                        <ComplianceBanner view={live} />
                        <AssistCards view={live} />
                        <TranscriptPanel view={live} agentLabel="You" />
                        <ScriptChecklist view={live} />
                      </div>
                    ) : (
                      <p className="text-zinc-400">Live transcription is off for this call. Call status: {callStatus}.</p>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <button onClick={toggleMute} disabled={!onCall} className={`rounded-xl px-3 py-3 text-sm font-medium ${muted ? "bg-amber-400 text-amber-950" : "bg-sky-500/20 text-sky-200"} disabled:opacity-40`}>
                      {muted ? "Unmute" : "Mute"}
                    </button>
                    <button onClick={toggleHold} disabled={!onCall || busy} className={`rounded-xl px-3 py-3 text-sm font-medium disabled:opacity-40 ${held ? "bg-amber-400 text-amber-950" : "bg-white/10 text-zinc-200"}`}>
                      {held ? "Resume" : "Hold"}
                    </button>
                    <button onClick={dropVoicemail} disabled={!onCall || busy} className="rounded-xl bg-violet-500/20 px-3 py-3 text-sm font-medium text-violet-200 disabled:opacity-40" title="It's a machine: leave the campaign's message and move on">
                      Leave VM & next
                    </button>
                    <button onClick={endCall} disabled={!onCall || busy || Boolean(transfer?.agentLeftAt)} className="rounded-xl bg-red-500/80 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40">
                      {transfer && !transfer.agentLeftAt && transfer.state !== "ended" ? "End for everyone" : "End Call"}
                    </button>
                  </div>
                  {onCall ? (
                    <div className="mt-3">
                      {transfer && transfer.state !== "ended" && !transfer.agentLeftAt ? (
                        <div className="rounded-xl border border-violet-400/30 bg-violet-400/10 p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-violet-500/20 px-1.5 text-[10px] uppercase text-violet-200">{transfer.mode === "COLD" ? "cold" : "warm"}</span>
                            <TransferStatus transfer={transfer} startedAt={xferStartedAt} />
                            {transfer.callerIdShown ? (
                              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-zinc-400">
                                they see {formatPhone(transfer.callerIdShown)}
                                {transfer.callerIdFallback ? " (fallback)" : ""}
                              </span>
                            ) : null}
                            <span className="flex-1" />
                            {transfer.mode === "WARM" && transfer.state === "answered" ? (
                              <>
                                <button onClick={leaveTransfer} disabled={busy} title="Drop off: the lead and the destination stay connected; you go to wrap-up" className="rounded-lg bg-violet-400 px-3 py-1.5 text-sm font-semibold text-violet-950 disabled:opacity-40">
                                  Leave call · they stay connected
                                </button>
                                <button onClick={endCall} disabled={busy} title="Hang up the lead and the destination" className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
                                  End call for everyone
                                </button>
                              </>
                            ) : null}
                            {transfer.state === "ringing" || (transfer.mode === "WARM" && transfer.state === "answered") ? (
                              <CancelTransferButton onCancel={cancelXfer} disabled={busy || transfer.id === "pending"} startedAt={xferStartedAt} />
                            ) : null}
                          </div>
                        </div>
                      ) : !xferMenu ? (
                        <button onClick={openXferMenu} disabled={busy || callStatus === "dialing"} className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
                          Transfer…
                        </button>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
                            <span>Transfer the lead to</span>
                            <button onClick={closeXferMenu} className="hover:text-zinc-100">
                              close
                            </button>
                          </div>
                          <div className="space-y-1">
                            {(campaign?.transferDestinations ?? []).map((d) => {
                              const mode = xferModes[d.id] ?? d.type;
                              const shows = d.callerIdMode === "CUSTOMER" ? (lead?.phone ? formatPhone(lead.phone) : "the lead's number") : d.staticCallerId ? formatPhone(d.staticCallerId) : "a fixed number";
                              return (
                                <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm">
                                  <button onClick={() => startTransfer(d)} disabled={busy} className="font-medium text-zinc-100 hover:text-white disabled:opacity-40">
                                    {d.name}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setXferModes((m) => ({ ...m, [d.id]: mode === "COLD" ? "WARM" : "COLD" }))}
                                    title="Cold: you drop off when they answer. Warm: three-way until you click Leave. Click to flip."
                                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${mode === "COLD" ? "bg-sky-500/20 text-sky-200" : "bg-amber-400/20 text-amber-200"}`}
                                  >
                                    {mode === "COLD" ? "cold" : "warm"} ⇄
                                  </button>
                                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-zinc-400" title="What the destination's phone shows as the caller">
                                    they see {shows}
                                  </span>
                                  <span className="flex-1" />
                                  <button onClick={() => startTransfer(d)} disabled={busy} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-400/20 disabled:opacity-40">
                                    Dial
                                  </button>
                                </div>
                              );
                            })}
                            {(campaign?.transferDestinations ?? []).length === 0 ? <div className="text-xs text-zinc-500">No transfer destinations on this campaign yet (campaign page → Transfers).</div> : null}
                          </div>
                          <div className="mt-3 border-t border-white/10 pt-2">
                            <div className="mb-1 text-xs text-zinc-400">Closers ready now on this campaign</div>
                            <div className="flex flex-wrap gap-2">
                              {(targets ?? []).map((t) => (
                                <button key={t.userId} onClick={() => doTransfer(t.userId)} disabled={busy} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-400/20">
                                  {t.name} <span className="text-[10px] text-emerald-300/80">{t.mode.toLowerCase()}</span>
                                </button>
                              ))}
                              {targets === null ? <span className="text-xs text-zinc-500">Looking…</span> : targets.length === 0 ? <span className="text-sm text-zinc-500">Nobody is free right now.</span> : null}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </Panel>

                </>
              ) : null}
              {/* SMS sits between the call and the lead card (owner, 6 Nov). */}
              {lead ? (
                <Panel title="SMS" right={<span className="text-xs text-zinc-500">{thread.length} messages</span>}>
                  <div className="mb-2 max-h-56 space-y-1 overflow-y-auto pr-1 text-sm">
                    {thread.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] rounded-xl px-3 py-1.5 ${m.direction === "OUTBOUND" ? "bg-sky-500/20 text-sky-100" : "bg-white/10 text-zinc-100"}`}>
                          <div>{m.body}</div>
                          <div className="mt-0.5 text-[10px] text-zinc-500">
                            {new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                            {m.purpose ? ` · ${m.purpose.replace("_", " ")}` : ""}
                            {m.status === "FAILED" ? " · failed" : ""}
                            {m.intent && m.intent !== "OTHER" ? <span className={m.intent === "OPT_OUT" ? " ml-1 text-rose-400" : " ml-1 text-amber-300"}> · {m.intent.toLowerCase().replace("_", " ")}</span> : null}
                          </div>
                        </div>
                      </div>
                    ))}
                    {thread.length === 0 ? <div className="text-xs text-zinc-500">No texts yet with this lead.</div> : null}
                  </div>
                  <div className="flex gap-2">
                    <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type a text…" className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600" />
                    <button onClick={send} disabled={busy || !draft.trim()} className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-40">
                      Send
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {["Hi {{first_name}}, this is {{agent}} following up on your request. Is now a good time?", "Sorry I missed you! When is a good time to call back?", "Thanks for your time today, {{first_name}}."].map((t) => (
                      <button key={t} onClick={() => setDraft(t.replace("{{first_name}}", lead.firstName ?? "there").replace("{{agent}}", me.name))} className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10">
                        {t.slice(0, 34)}…
                      </button>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {lead ? (
                leadCard
              ) : (
                <Panel title="System & Queue Activity" collapsible={false}>
                  <div className="mb-4 rounded-xl bg-gradient-to-b from-cyan-500/10 to-transparent p-6 text-center">
                    <Waveform colors={["#22d3ee", "#0ea5e9"]} className="mx-auto mb-3 justify-center" />
                    <div className="text-lg font-medium">{ready ? (campaign?.dialMode === "PREVIEW" ? "Ready to work the next lead" : "Scanning and dialing… Please remain ready") : state === "PAUSED" ? "Paused" : "Not dialing"}</div>
                    <div className="mt-1 text-sm text-zinc-400">
                      Queue depth <span className="text-cyan-300">{stats?.queueDepth ?? "—"}</span> · callbacks due <span className="text-cyan-300">{stats?.callbacksDue ?? "—"}</span>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="rounded-lg bg-black/30 p-3">
                      <div className="text-xs text-zinc-500">Campaign</div>
                      <div>{campaign ? `${campaign.name} · ${campaign.dialMode === "RATIO" ? "ratio dialing" : "preview dialing"}` : "none"}</div>
                    </div>
                    <div className="rounded-lg bg-black/30 p-3">
                      <div className="text-xs text-zinc-500">Your line</div>
                      <div>{phone === "in-room" ? "Up and in your room" : phone === "registered" ? "Registered, idle" : phoneError ?? "Offline"}</div>
                    </div>
                  </div>
                </Panel>
              )}


              <Panel title="Live Activity Feed">
                <ul className="space-y-2 text-sm">
                  {(stats?.feed ?? []).map((f, i) => (
                    <li key={i} className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2">
                      <span className={`grid h-7 w-7 place-items-center rounded-md text-xs font-bold ${f.tone === "sms" ? "bg-emerald-500 text-white" : f.tone === "lead" ? "bg-orange-500 text-white" : "bg-sky-500 text-white"}`}>{f.tone === "sms" ? "✉" : f.tone === "lead" ? "★" : "☎"}</span>
                      <span className="flex-1 truncate">{f.text}</span>
                      <span className="text-xs text-zinc-500">{new Date(f.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    </li>
                  ))}
                  {stats && stats.feed.length === 0 ? <li className="text-zinc-500">Quiet so far today.</li> : null}
                </ul>
              </Panel>

              {lead && history.length ? (
                <Panel title="Lead history" defaultOpen={false}>
                  <ul className="space-y-1 text-xs text-zinc-400">
                    {history.map((h, i) => (
                      <li key={i}>
                        <span className="text-zinc-500">{new Date(h.at).toLocaleString()}</span> · {h.kind.toLowerCase()} {h.actor ? `· ${h.actor}` : ""} {h.data.code ? `· ${String(h.data.code)}` : ""} {h.data.note ? `· ${String(h.data.note)}` : ""}
                        {h.data.changes && typeof h.data.changes === "object"
                          ? Object.entries(h.data.changes as Record<string, { from: string | null; to: string | null }>)
                              .filter(([k]) => k !== "notes")
                              .map(([k, c]) => ` · ${k}: ${c.from ?? "—"} → ${c.to ?? "—"}`)
                              .join("")
                          : ""}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>

            {/* My team (leaders), chat, sprint, leaderboard */}
            <div className="space-y-4">
              {isLeader && teams.length ? <TeamPanel teams={teams} live={liveAgents} me={me.id} phoneIdle={phone === "registered" && line === "down"} watching={watching} onWatch={watch} onMessage={(id) => setDmWith(id)} /> : null}
              {onCall ? <AssistPanel campaignId={campaignId} leadId={lead?.id ?? null} compact /> : null}
              <Panel title="Chat">
                <ChatPanel socket={sock} meId={me.id} openDirectWith={dmWith} height="h-56" />
              </Panel>
              {can("games") ? <GamesPanel g={games} meId={me.id} campaignId={campaignId} Panel={Panel} /> : null}
              <SprintPanel stats={stats} />
              <Leaderboard stats={stats} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr_320px]">
            <div className="space-y-4">
              {screenerBanner}
              {liveOn && (onCall || wrapUp) ? (
                <Panel title="Live call" collapsible={false} right={<span className="text-xs text-zinc-500">transcript & assist</span>}>
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
                    <div className="space-y-3">
                      <ComplianceBanner view={live} />
                      <TranscriptPanel view={live} height="h-80" agentLabel="You" />
                    </div>
                    <div className="space-y-3">
                      <AssistCards view={live} />
                      <ScriptChecklist view={live} />
                    </div>
                  </div>
                </Panel>
              ) : null}
              {aiPanel}
              <Panel title="Script" right={lead ? <span className="text-xs text-zinc-500">personalised for {leadName}</span> : null}>
                {script ? (
                  <div className="max-h-[60vh] space-y-2 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
                    {renderScript(script, { agentName: me.name, company: me.tenant, lead })}
                  </div>
                ) : (
                  <div className="text-sm text-zinc-500">No script for this campaign yet. A supervisor adds one on the campaign page.</div>
                )}
              </Panel>
              <AssistPanel campaignId={campaignId} leadId={lead?.id ?? null} />
              {can("games") ? <GamesPanel g={games} meId={me.id} campaignId={campaignId} Panel={Panel} /> : null}
            </div>

            <div className="space-y-4">
              <Panel title="Lead Queue & Tasks" right={<span className="text-xs text-zinc-500">queue {stats?.queueDepth ?? "—"}</span>}>
                {lead ? (
                  <CollapsibleLeadCard
                    summary={
                      <>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{leadName}</span>
                          <span className="rounded bg-sky-400/20 px-1.5 text-xs text-sky-200">{onCall ? "on call" : wrapUp ? "wrap-up" : "active"}</span>
                        </div>
                        <div className="text-xs text-zinc-400">
                          {[lead.city, lead.state].filter(Boolean).join(", ")} · local time {localTime ?? "?"} · {lead.attemptsTotal} attempts
                        </div>
                      </>
                    }
                  >
                    {leadCard}
                  </CollapsibleLeadCard>
                ) : null}
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Upcoming leads</div>
                <ul className="space-y-1 text-sm">
                  {upcoming.map((u) => (
                    <li key={u.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate">{u.name}</div>
                        <div className="truncate text-[11px] text-zinc-500">
                          {u.location || "—"} · local {u.localTime ?? "?"} · {u.listName} (P{u.priority}) · {u.attempts} tries{u.lastOutcome ? ` · last: ${u.lastOutcome.toLowerCase().replace("_", " ")}` : ""}
                        </div>
                      </div>
                      <span className="ml-2 rounded bg-emerald-500/15 px-1.5 text-[10px] text-emerald-300">{u.attempts === 0 ? "fresh" : "up next"}</span>
                    </li>
                  ))}
                  {upcoming.length === 0 ? <li className="text-xs text-zinc-500">Nothing waiting that may be dialed right now.</li> : null}
                </ul>
              </Panel>
              {isLeader && teams.length ? <TeamPanel teams={teams} live={liveAgents} me={me.id} phoneIdle={phone === "registered" && line === "down"} watching={watching} onWatch={watch} onMessage={(id) => setDmWith(id)} /> : null}
              <Panel title="Chat">
                <ChatPanel socket={sock} meId={me.id} openDirectWith={dmWith} height="h-64" />
              </Panel>
              <Panel title="My callbacks" right={<span className="text-xs text-zinc-500">{callbacks.filter((c) => c.overdue).length} due</span>}>
                <ul className="space-y-1 text-sm">
                  {callbacks.map((c) => (
                    <li key={c.id} className={`rounded-lg px-3 py-1.5 ${c.overdue ? "bg-amber-500/10 text-amber-100" : "bg-white/5"}`}>
                      <div className="flex items-center justify-between">
                        <span>{c.name}</span>
                        <span className="text-xs">{new Date(c.dueAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        {formatPhone(c.phone)} · {c.scope === "AGENT" ? "yours" : "campaign"}
                        {c.note ? ` · ${c.note}` : ""}
                      </div>
                    </li>
                  ))}
                  {callbacks.length === 0 ? <li className="text-xs text-zinc-500">No callbacks in the next 8 hours.</li> : null}
                </ul>
              </Panel>
              {lead ? (
                <Panel title="Text thread" right={<span className="text-xs text-zinc-500">{thread.length}</span>}>
                  <div className="max-h-56 space-y-1 overflow-y-auto text-sm">
                    {thread.map((m) => (
                      <div key={m.id} className={`flex ${m.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[85%] rounded-xl px-3 py-1.5 ${m.direction === "OUTBOUND" ? "bg-sky-500/20 text-sky-100" : "bg-white/10"}`}>{m.body}</div>
                      </div>
                    ))}
                    {thread.length === 0 ? <div className="text-xs text-zinc-500">No texts yet.</div> : null}
                  </div>
                </Panel>
              ) : null}
            </div>

            <div className="space-y-4">
              <Leaderboard stats={stats} />
              <SprintPanel stats={stats} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SprintPanel({ stats }: { stats: Sprint | null }) {
  return (
    <Panel title="Today's Sprint & Progress">
      {stats ? (
        <>
          <Bar label="Calls" value={stats.dials} max={stats.goals.dials} from="#3b82f6" to="#a855f7" />
          <Bar label="Contacts" value={stats.contacts} max={stats.goals.contacts} from="#22d3ee" to="#3b82f6" />
          <Bar label="Sales" value={stats.sales} max={stats.goals.sales} from="#84cc16" to="#22c55e" />
          <div className="text-xs text-zinc-500">Talk time {Math.round(stats.talkSeconds / 60)} min</div>
        </>
      ) : (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}
    </Panel>
  );
}

function Leaderboard({ stats }: { stats: Sprint | null }) {
  return (
    <Panel title="Mini Team Leaderboard">
      <ol className="space-y-1 text-sm">
        {(stats?.leaderboard ?? []).map((r, i) => (
          <li key={r.userId} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${r.you ? "bg-emerald-400/10 text-emerald-200" : "bg-white/5"}`}>
            <span className="w-4 text-xs text-zinc-500">{i + 1}</span>
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-xs font-bold text-white">{r.name.slice(0, 1).toUpperCase()}</span>
            <span className="flex-1 truncate">
              {r.name}
              {r.you ? " (You)" : ""}
            </span>
            <span className="text-xs tabular-nums text-zinc-400">
              {r.sales} sales · {r.contacts} contacts
            </span>
          </li>
        ))}
        {stats && stats.leaderboard.length === 0 ? <li className="text-zinc-500">No calls yet today.</li> : null}
      </ol>
    </Panel>
  );
}

function TeamPanel({ teams, live, me, phoneIdle, watching, onWatch, onMessage }: { teams: { id: string; name: string; members: { id: string; name: string }[] }[]; live: Record<string, AgentLive>; me: string; phoneIdle: boolean; watching: { agentId: string; mode: SuperviseMode } | null; onWatch: (agentId: string, mode: SuperviseMode | null) => void; onMessage: (userId: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const tone = (st: string | undefined) => (st === "ON_CALL" ? "bg-sky-500/20 text-sky-200" : st === "READY" ? "bg-emerald-500/20 text-emerald-200" : st === "WRAP_UP" ? "bg-fuchsia-500/20 text-fuchsia-200" : st === "PAUSED" ? "bg-amber-500/20 text-amber-200" : "bg-white/5 text-zinc-500");
  const ago = (since: number | undefined) => {
    if (!since) return "";
    const m = Math.round((now - since) / 60_000);
    return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  };
  const onlineCount = teams.reduce((n, t) => n + t.members.filter((m) => live[m.id] && m.id !== me).length, 0);
  const modes: SuperviseMode[] = ["LISTEN", "WHISPER", "BARGE"];
  return (
    <Panel title="My Team" right={<span className="text-xs text-zinc-500">{onlineCount} online</span>}>
      {teams.map((t) => (
        <div key={t.id} className="mb-2">
          {teams.length > 1 ? <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">{t.name}</div> : null}
          <ul className="space-y-1 text-sm">
            {t.members
              .filter((m) => m.id !== me)
              .map((m) => {
                const l = live[m.id];
                const st = l?.state;
                const mine = watching?.agentId === m.id;
                return (
                  <li key={m.id} className="rounded-lg bg-white/5 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-[10px] font-bold text-white">{m.name.slice(0, 1).toUpperCase()}</span>
                      <span className="flex-1 truncate">{m.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone(st)}`}>{st ? `${st.replace("_", " ")} ${ago(l?.since)}` : "offline"}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <button onClick={() => onMessage(m.id)} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10">
                        Message
                      </button>
                      {st === "ON_CALL" && mine ? (
                        <>
                          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">{watching?.mode.toLowerCase()}</span>
                          {modes
                            .filter((x) => x !== watching?.mode)
                            .map((x) => (
                              <button key={x} onClick={() => onWatch(m.id, x)} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10">
                                {x.toLowerCase()}
                              </button>
                            ))}
                          <button onClick={() => onWatch(m.id, null)} className="rounded border border-red-500/40 px-1.5 py-0.5 text-[10px] text-red-200 hover:bg-red-500/10">
                            stop
                          </button>
                        </>
                      ) : st === "ON_CALL" ? (
                        modes.map((x) => (
                          <button key={x} onClick={() => onWatch(m.id, x)} disabled={!phoneIdle} title={phoneIdle ? "" : "Pause your own line first: listening uses your softphone"} className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10 disabled:opacity-40">
                          {x.toLowerCase()}
                        </button>
                        ))
                      ) : null}
                    </div>
                  </li>
                );
              })}
            {t.members.filter((m) => m.id !== me).length === 0 ? <li className="text-xs text-zinc-500">No members yet. Add them on Teams &amp; rooms.</li> : null}
          </ul>
        </div>
      ))}
    </Panel>
  );
}

/** What to say next: the campaign's rebuttal library, and an AI suggestion for whatever the person just said. */
function AssistPanel({ campaignId, leadId, compact = false }: { campaignId: string; leadId: string | null; compact?: boolean }) {
  const [rebuttals, setRebuttals] = useState<{ objection: string; response: string }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [heard, setHeard] = useState("");
  const [goal, setGoal] = useState<"sale" | "service">("sale");
  const [out, setOut] = useState<{ suggestions: Suggestion[]; tone: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!campaignId) return;
    const t = setTimeout(() => void campaignRebuttals(campaignId).then(setRebuttals), 0);
    return () => clearTimeout(t);
  }, [campaignId]);
  const ask = async () => {
    if (!heard.trim() || !campaignId) return;
    setBusy(true);
    setErr(null);
    const r = await assistSuggest(campaignId, leadId, heard, goal);
    if (r.ok) setOut({ suggestions: r.suggestions, tone: r.tone });
    else setErr(r.error);
    setBusy(false);
  };
  const filtered = heard.trim().length > 2 ? rebuttals.filter((r) => r.objection.toLowerCase().includes(heard.toLowerCase().trim())) : rebuttals;
  return (
    <Panel title="Agent Assist" right={<span className="text-xs text-zinc-500">{rebuttals.length} rebuttals</span>} defaultOpen={!compact}>
      <div className="mb-2 flex gap-2">
        <input value={heard} onChange={(e) => setHeard(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ask()} placeholder="What did they just say?" className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600" />
        <select value={goal} onChange={(e) => setGoal(e.target.value as "sale" | "service")} className="rounded-lg border border-white/10 bg-black/30 px-2 text-xs">
          <option value="sale">sale</option>
          <option value="service">service</option>
        </select>
        <button onClick={() => void ask()} disabled={busy || !heard.trim()} className="rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {busy ? "…" : "Suggest"}
        </button>
      </div>
      {err ? <div className="mb-2 text-xs text-red-300">{err}</div> : null}
      {out ? (
        <div className="mb-3 space-y-2">
          {out.suggestions.map((s, i) => (
            <div key={i} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">
                {s.title} · {out.tone}
              </div>
              <div className="text-zinc-100">&ldquo;{s.say}&rdquo;</div>
              <div className="mt-0.5 text-xs text-zinc-400">{s.why}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`${compact ? "max-h-40" : "max-h-72"} space-y-1 overflow-y-auto text-sm`}>
        {filtered.map((r, i) => (
          <button key={i} onClick={() => setOpen(open === i ? null : i)} className="block w-full rounded-lg bg-white/5 px-3 py-1.5 text-left hover:bg-white/10">
            <div className="text-zinc-300">&ldquo;{r.objection}&rdquo;</div>
            {open === i ? <div className="mt-1 text-zinc-100">{r.response}</div> : null}
          </button>
        ))}
        {rebuttals.length === 0 ? <div className="text-xs text-zinc-500">No rebuttals on this campaign yet. A supervisor adds them on the campaign page; the Suggest button still works from the script.</div> : null}
      </div>
    </Panel>
  );
}
