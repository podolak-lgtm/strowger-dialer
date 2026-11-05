"use client";

// The agent console. One component, two screens:
//   ?screen=main   (default) status banner, lead card, call controls,
//                  dispositions, activity feed
//   ?screen=assist upcoming leads, leaderboard, goals, agent assist
// Open /agent?screen=assist in a second window for a two-monitor desk; on
// one monitor every column collapses with the chevrons.
import { createJambonzClient } from "@jambonz/client-sdk-web";
import { ChatPanel } from "@/components/chat-panel";
import { myTeams } from "@/lib/chat-actions";
import { assistSuggest, campaignRebuttals, gamesOverview, type GamesOverview, type Suggestion } from "@/lib/games-actions";
import { prettyCard } from "@strowger/shared/games";
import { superviseStart, superviseStop, type SuperviseMode } from "../floor/actions";
import { formatPhone } from "@strowger/shared/phone";
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
  dialLead,
  disposition,
  hangup,
  holdCall,
  leadById,
  leadHistory,
  leaveVoicemail,
  manualDial,
  transferCall,
  transferTargets,
  nextLead,
  sendText,
  skipLead,
  sprint,
  textThread,
  updateLeadNotes,
  type AgentLive,
  type LeadCard,
  type LeadHistory,
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
    dispositions: Array<{ id: string; code: string; label: string; hotkey: string | null; isCallback: boolean; isSale: boolean; isDnc: boolean }>;
  }>;
  sip: { server: string; realm: string; username: string; password: string; applicationSid: string } | null;
  engineUrl: string;
  rtToken: string;
  screen: "main" | "assist";
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

export function AgentConsole(props: ConsoleProps) {
  const { me, campaigns, sip, engineUrl, rtToken, screen, roles, rights, billing } = props;
  const can = (r: string) => rights.includes(r);
  const [campaignId, setCampaignId] = useState<string>(campaigns[0]?.id ?? "");
  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;
  const [agent, setAgent] = useState<AgentLive | null>(null);
  const [phone, setPhone] = useState<PhoneState>("off");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [lead, setLead] = useState<LeadCard | null>(null);
  const [history, setHistory] = useState<LeadHistory>([]);
  const [callId, setCallId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState<string>("idle");
  const [callStart, setCallStart] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [stats, setStats] = useState<Sprint | null>(null);
  const [thread, setThread] = useState<TextMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [upcoming, setUpcoming] = useState<UpcomingLead[]>([]);
  const [callbacks, setCallbacks] = useState<MyCallback[]>([]);
  const [script, setScript] = useState<string | null>(null);
  const [twoScreen, setTwoScreen] = useState(false);
  const [held, setHeld] = useState(false);
  const [targets, setTargets] = useState<TransferTarget[] | null>(null);
  const [manual, setManual] = useState("");
  const assistWin = useRef<Window | null>(null);
  const [busy, setBusy] = useState(false);
  const [pauseMenu, setPauseMenu] = useState(false);
  const [sock, setSock] = useState<Socket | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string; members: { id: string; name: string }[] }[]>([]);
  const [liveAgents, setLiveAgents] = useState<Record<string, AgentLive>>({});
  const [dmWith, setDmWith] = useState<string | null>(null);
  const [watching, setWatching] = useState<{ agentId: string; mode: SuperviseMode } | null>(null);
  const isLeader = roles.includes("TEAM_LEADER") || roles.includes("SUPERVISOR") || roles.includes("ADMIN");

  const clientRef = useRef<JambonzClient | null>(null);
  const roomCallRef = useRef<JambonzCall | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const timer = useTicker(callStatus !== "idle" && callStatus !== "ended", callStart);

  /** Listen / whisper / barge on a team member, or stop. Needs my own line idle (registered, not in a room). */
  const watch = useCallback(async (agentId: string, mode: SuperviseMode | null) => {
    if (!mode) {
      await superviseStop();
      setWatching(null);
      return;
    }
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
        }
      }
    })();
  }, []);

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
        if (id) void leadById(id).then((l) => l && setLead(l));
        if (!id && !live.currentCallId) setLead(null);
      }
      if (live.currentCallId && live.currentCallId !== callId) setCallId(live.currentCallId);
      if (live.state === "READY" && !live.currentCallId) {
        setCallId(null);
        setCallStatus("idle");
        setCallStart(null);
      }
    });
    sock.on("text:in", (m: { leadId: string | null; body: string; from: string; action?: string; intent?: string | null }) => {
      const flag = m.action === "opt_out" ? " · OPTED OUT, lead closed" : m.action === "review" ? " · possible opt-out, check before calling" : m.action === "callback" ? " · callback booked" : "";
      setNotice(`Text from ${m.from.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}: ${m.body.slice(0, 80)}${flag}`);
      if (m.leadId) void textThread(m.leadId).then(setThread);
      void refreshStats();
    });
    sock.on("call:update", (u: { callId: string; status: string; leadId?: string; outcome?: string; inbound?: boolean; from?: string | null }) => {
      setCallId(u.callId);
      setCallStatus(u.status);
      if (u.inbound) setNotice(`Inbound call${u.from ? ` from ${u.from.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}` : ""}: connected to you.`);
      if (u.leadId) {
        // Ratio mode: the lead arrives with the live call.
        void leadById(u.leadId).then((l) => {
          if (l) {
            setLead(l);
            void leadHistory(l.id).then(setHistory);
          }
        });
      }
      if (u.status === "bridged" || u.status === "answered") setCallStart((s) => s ?? Date.now());
      if (u.status === "ended") {
        setHeld(false);
        setTargets(null);
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

  // Softphone: register once; the nailed-up leg is raised when the agent goes Ready.
  const connectPhone = useCallback(async () => {
    if (!sip || clientRef.current) return;
    setPhone("connecting");
    setPhoneError(null);
    try {
      const client = createJambonzClient({ server: sip.server, username: sip.username, password: sip.password, realm: sip.realm || undefined, displayName: me.name });
      client.on("registered", () => setPhone((p) => (p === "in-room" ? p : "registered")));
      client.on("registrationFailed", (e: Error) => {
        setPhone("error");
        setPhoneError(e.message);
      });
      client.on("disconnected", () => setPhone("off"));
      client.on("error", (e: Error) => setPhoneError(e.message));
      // The only thing that rings an agent's softphone is a supervision leg the engine placed for them (a team leader listening in): answer it unless the line is already up in a room.
      client.on("incoming", (call: { answer: () => void; hangup?: () => void }) => {
        if (roomCallRef.current) call.hangup?.();
        else call.answer();
      });
      await client.connect();
      clientRef.current = client;
      setPhone("registered");
    } catch (e) {
      setPhone("error");
      setPhoneError(e instanceof Error ? e.message : String(e));
    }
  }, [sip, me.name]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (sip) void connectPhone();
    }, 0);
    return () => {
      clearTimeout(t);
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [sip, connectPhone]);

  const raiseLine = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !sip) throw new Error("Softphone is not registered");
    if (roomCallRef.current) return;
    const call = sip.applicationSid ? client.callApplication(sip.applicationSid) : client.call("ready");
    roomCallRef.current = call;
    call.on("accepted", () => setPhone("in-room"));
    call.on("ended", () => {
      roomCallRef.current = null;
      setPhone(client.isRegistered ? "registered" : "off");
    });
    call.on("failed", (e: { code?: number; reason?: string }) => {
      roomCallRef.current = null;
      setPhone("registered");
      setNotice(`Line failed: ${e.reason ?? e.code ?? "unknown"}`);
    });
    call.on("mute", (m: boolean) => setMuted(m));
  }, [sip]);

  const dropLine = useCallback(() => {
    roomCallRef.current?.hangup();
    roomCallRef.current = null;
  }, []);

  // Actions
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
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
      await raiseLine();
      // The engine flips to READY when the leg joins the room; nudge in case it was paused.
      if (agent.agentCallSid) {
        const r = await agentSetState("READY");
        if (!r.ok) throw new Error(r.error);
      }
    });

  const pause = (reason: string) =>
    run(async () => {
      setPauseMenu(false);
      const r = await agentSetState("PAUSED", reason);
      if (!r.ok) throw new Error(r.error);
    });

  const logout = () =>
    run(async () => {
      dropLine();
      await agentLogout();
      setAgent(null);
      setLead(null);
      setCallId(null);
      setCallStatus("idle");
    });

  const fetchNext = () =>
    run(async () => {
      const r = await nextLead();
      if (!r.ok) throw new Error(r.error);
      setLead(r.lead);
      setHistory(await leadHistory(r.lead.id));
      setNotes("");
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

  const endCall = () =>
    run(async () => {
      if (callId) await hangup(callId);
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

  const openTransfer = () =>
    run(async () => {
      setTargets(await transferTargets(campaignId || null));
    });

  const doTransfer = (toAgentId: string) =>
    run(async () => {
      if (!callId) return;
      const r = await transferCall(callId, toAgentId);
      if (!r.ok) throw new Error(r.error);
      setTargets(null);
      setNotice("Transferred. Disposition your part of the call.");
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
        if (l) setLead(l);
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

  const dispo = (d: ConsoleProps["campaigns"][number]["dispositions"][number]) =>
    run(async () => {
      if (!callId) throw new Error("No call to disposition");
      if (d.isCallback && !callbackAt) throw new Error("Pick a callback time");
      const r = await disposition({ callId, dispositionId: d.id, notes: notes || undefined, callbackAt: d.isCallback ? new Date(callbackAt).toISOString() : undefined });
      if (!r.ok) throw new Error(r.error);
      if (lead && notes) await updateLeadNotes(lead.id, { note: notes });
      setLead(null);
      setCallId(null);
      setCallStatus("idle");
      setCallStart(null);
      setNotes("");
      setCallbackAt("");
      void refreshStats();
    });

  // Hotkeys for dispositions during wrap-up.
  useEffect(() => {
    if (!campaign || agent?.state !== "WRAP_UP") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      const d = campaign.dispositions.find((x) => x.hotkey === e.key);
      if (d) void dispo(d);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign, agent?.state, callId, notes, callbackAt]);

  const state = agent?.state ?? "LOGGED_OUT";
  const onCall = state === "ON_CALL";
  const wrapUp = state === "WRAP_UP";
  const ready = state === "READY";
  const canDialOut = campaign ? campaign.agentMode !== "CLOSER" || (campaign.closersMayDial && campaign.outboundOn) : false;

  const banner =
    state === "LOGGED_OUT"
      ? { label: "OFFLINE", sub: "Pick a campaign and log in", color: "#8b8f9a" }
      : state === "LOGGED_IN"
        ? { label: "LOGGED IN", sub: phone === "registered" ? "Click Ready to bring your line up" : phone === "connecting" ? "Registering softphone…" : phone === "error" ? `Softphone error: ${phoneError}` : "Softphone offline", color: "#f5c452" }
        : state === "READY"
          ? { label: "READY", sub: campaign?.dialMode === "PREVIEW" ? "Preview mode · pull the next lead when you are" : "Waiting for Live Call", color: "#3ddc97" }
          : state === "PAUSED"
            ? { label: "PAUSED", sub: agent?.pauseReason ?? "On break", color: "#f5c452" }
            : state === "ON_CALL"
              ? { label: "ON CALL", sub: callStatus === "dialing" ? "Dialing…" : callStatus === "answered" ? "Answered · connecting" : "Live", color: "#5ab4ff" }
              : { label: "WRAP-UP", sub: "Disposition the call", color: "#c084fc" };

  const leadName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown name" : "";
  const localTime = lead?.timezone ? new Intl.DateTimeFormat("en-US", { timeZone: lead.timezone, hour: "numeric", minute: "2-digit" }).format(new Date()) : null;

  return (
    <div className="flex min-h-screen">
      <style>{`@keyframes sw-pulse{0%,100%{transform:scaleY(.35);opacity:.5}50%{transform:scaleY(1);opacity:1}}`}</style>

      {/* Rail */}
      <aside className="flex w-16 flex-col items-center gap-3 border-r border-white/10 bg-black/20 py-4">
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-lg font-black text-white">S</div>
        {[
          ["main", "Console", "⌂"],
          ["assist", "Assist", "▦"],
        ].map(([key, label, glyph]) => (
          <a key={key} href={`/agent?screen=${key}`} title={label} className={`grid h-10 w-10 place-items-center rounded-xl text-lg ${screen === key ? "bg-white/15 text-cyan-300" : "text-zinc-400 hover:bg-white/10"}`}>
            {glyph}
          </a>
        ))}
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
            <span className={`rounded-full px-2 py-0.5 text-xs ${phone === "in-room" ? "bg-emerald-500/20 text-emerald-300" : phone === "registered" ? "bg-sky-500/20 text-sky-300" : phone === "error" ? "bg-red-500/20 text-red-300" : "bg-white/10 text-zinc-400"}`}>
              {sip ? (phone === "in-room" ? "line up" : phone === "registered" ? "phone registered" : phone === "connecting" ? "registering…" : phone === "error" ? "phone error" : "phone offline") : "no softphone line issued"}
            </span>
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
            {!agent ? (
              <button onClick={login} disabled={busy || !campaignId} className="rounded-lg bg-white px-3 py-1.5 font-medium text-zinc-900 disabled:opacity-50">
                Log in
              </button>
            ) : (
              <>
                {!ready && !onCall && !wrapUp ? (
                  <button onClick={goReady} disabled={busy || phone === "off" || phone === "error"} className="rounded-lg bg-emerald-400 px-3 py-1.5 font-semibold text-emerald-950 disabled:opacity-50">
                    Ready
                  </button>
                ) : null}
                {ready ? (
                  <div className="relative">
                    <button onClick={() => setPauseMenu((m) => !m)} disabled={busy} className="rounded-lg border border-white/15 px-3 py-1.5 text-zinc-200 hover:bg-white/10">
                      Pause ▾
                    </button>
                    {pauseMenu ? (
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
            <div className="ml-3 grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-xs font-bold">{me.name.slice(0, 1).toUpperCase()}</div>
          </div>
        </div>

        {notice ? <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice}</div> : null}

        {/* Status banner */}
        <div className="mb-5 flex items-center justify-center gap-6 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-6 py-5">
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
        </div>

        {screen === "main" ? (
          <div className="grid gap-4 xl:grid-cols-[320px_1fr_300px]">
            {/* Lead profile + dispositions */}
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
                    {ready && canDialOut ? (
                      <div className="flex gap-2">
                        <input value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dialManual()} placeholder="Dial a number…" className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600" />
                        <button onClick={dialManual} disabled={busy || !manual.trim()} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-40">
                          Dial
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center gap-3">
                      <div className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-500 text-base font-bold">{leadName.slice(0, 1).toUpperCase()}</div>
                      <div>
                        <div className="text-base font-semibold">{leadName}</div>
                        <div className="text-xs text-zinc-400">{localTime ? `Local time ${localTime}` : "Local time unknown"}</div>
                      </div>
                    </div>
                    <div className="space-y-1 text-zinc-300">
                      <div className="font-mono">{formatPhone(lead.phone)}</div>
                      {lead.email ? <div>{lead.email}</div> : null}
                      <div className="text-zinc-400">
                        {[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ")}
                      </div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {lead.leadType ? <span className="rounded bg-fuchsia-500/20 px-1.5 py-0.5 text-xs text-fuchsia-200">{lead.leadType}</span> : null}
                        <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-zinc-300">posted {new Date(lead.postedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    {Object.keys(lead.custom ?? {}).length ? (
                      <div className="rounded-lg bg-black/30 p-2 text-xs text-zinc-400">
                        {Object.entries(lead.custom).slice(0, 8).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <span className="text-zinc-500">{k}</span>
                            <span className="truncate">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Quick notes…" rows={3} className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600" />
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

              <Panel title="Call Dispositions" right={wrapUp ? <span className="rounded bg-fuchsia-500/20 px-1.5 text-xs text-fuchsia-200">wrap-up</span> : null}>
                {!campaign ? null : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      {campaign.dispositions.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => dispo(d)}
                          disabled={busy || !callId || (!wrapUp && !onCall)}
                          className={`rounded-lg border px-2 py-2 text-left text-xs disabled:opacity-40 ${d.isSale ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : d.isDnc ? "border-red-400/40 bg-red-400/10 text-red-200" : d.isCallback ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-white/10 bg-white/5 text-zinc-200"} hover:bg-white/10`}
                        >
                          <div className="font-semibold">
                            {d.label}
                            {d.hotkey ? <span className="ml-1 rounded bg-black/30 px-1 font-mono text-[10px] text-zinc-400">{d.hotkey}</span> : null}
                          </div>
                          <div className="font-mono text-[10px] text-zinc-500">{d.code}</div>
                        </button>
                      ))}
                    </div>
                    {campaign.dispositions.some((d) => d.isCallback) ? (
                      <label className="block text-xs text-zinc-400">
                        Callback time
                        <input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-100" />
                      </label>
                    ) : null}
                  </div>
                )}
              </Panel>
            </div>

            {/* Call in progress / waiting feed */}
            <div className="space-y-4">
              {onCall || wrapUp ? (
                <Panel title={onCall ? `Call in Progress • ${timer}` : "Call ended"} collapsible={false}>
                  <div className="mb-4 flex items-center justify-center gap-4">
                    <Waveform colors={["#22d3ee", "#a855f7"]} />
                  </div>
                  <div className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-emerald-300/80">Communication & Live Transcript</div>
                    <p className="text-zinc-400">Live transcription arrives in a later phase. Call status: {callStatus}.</p>
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
                    <button onClick={endCall} disabled={!onCall || busy} className="rounded-xl bg-red-500/80 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40">
                      End Call
                    </button>
                  </div>
                  {onCall ? (
                    <div className="mt-3">
                      {targets === null ? (
                        <button onClick={openTransfer} disabled={busy} className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10">
                          Transfer to a closer…
                        </button>
                      ) : (
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
                            <span>Ready now on this campaign</span>
                            <button onClick={() => setTargets(null)} className="hover:text-zinc-100">
                              close
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {targets.map((t) => (
                              <button key={t.userId} onClick={() => doTransfer(t.userId)} disabled={busy} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-400/20">
                                {t.name} <span className="text-[10px] text-emerald-300/80">{t.mode.toLowerCase()}</span>
                              </button>
                            ))}
                            {targets.length === 0 ? <span className="text-sm text-zinc-500">Nobody is free right now.</span> : null}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </Panel>
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
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>

            {/* My team (leaders), chat, sprint, leaderboard */}
            <div className="space-y-4">
              {isLeader && teams.length ? <TeamPanel teams={teams} live={liveAgents} me={me.id} phoneIdle={phone === "registered"} watching={watching} onWatch={watch} onMessage={(id) => setDmWith(id)} /> : null}
              {onCall ? <AssistPanel campaignId={campaignId} leadId={lead?.id ?? null} compact /> : null}
              <Panel title="Chat">
                <ChatPanel socket={sock} meId={me.id} openDirectWith={dmWith} height="h-56" />
              </Panel>
              <SprintPanel stats={stats} />
              <Leaderboard stats={stats} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr_320px]">
            <div className="space-y-4">
              <Panel title="Script" right={lead ? <span className="text-xs text-zinc-500">personalised for {leadName}</span> : null}>
                {script ? (
                  <div className="max-h-[60vh] space-y-2 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
                    {script
                      .replace(/\{\{\s*first_name\s*\}\}/g, lead?.firstName ?? "there")
                      .replace(/\{\{\s*last_name\s*\}\}/g, lead?.lastName ?? "")
                      .replace(/\{\{\s*agent\s*\}\}/g, me.name)
                      .replace(/\{\{\s*company\s*\}\}/g, me.tenant)
                      .replace(/\{\{\s*city\s*\}\}/g, lead?.city ?? "your area")
                      .replace(/\{\{\s*state\s*\}\}/g, lead?.state ?? "")}
                  </div>
                ) : (
                  <div className="text-sm text-zinc-500">No script for this campaign yet. A supervisor adds one on the campaign page.</div>
                )}
              </Panel>
              <AssistPanel campaignId={campaignId} leadId={lead?.id ?? null} />
              {can("games") ? <GamesPanel meId={me.id} /> : null}
            </div>

            <div className="space-y-4">
              <Panel title="Lead Queue & Tasks" right={<span className="text-xs text-zinc-500">queue {stats?.queueDepth ?? "—"}</span>}>
                {lead ? (
                  <div className="mb-3 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-sm text-zinc-100">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{leadName}</span>
                      <span className="rounded bg-sky-400/20 px-1.5 text-xs text-sky-200">{onCall ? "on call" : wrapUp ? "wrap-up" : "active"}</span>
                    </div>
                    <div className="text-xs text-zinc-400">
                      {[lead.city, lead.state].filter(Boolean).join(", ")} · local time {localTime ?? "?"} · {lead.attemptsTotal} attempts
                    </div>
                  </div>
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
              {isLeader && teams.length ? <TeamPanel teams={teams} live={liveAgents} me={me.id} phoneIdle={phone === "registered"} watching={watching} onWatch={watch} onMessage={(id) => setDmWith(id)} /> : null}
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

function GamesPanel({ meId }: { meId: string }) {
  const [o, setO] = useState<GamesOverview | null>(null);
  useEffect(() => {
    const load = () => void gamesOverview().then(setO).catch(() => undefined);
    const first = setTimeout(load, 0);
    const t = setInterval(load, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  if (!o || !o.settings.enabled) return null;
  const mine = o.poker.rows.find((r) => r.userId === meId);
  const open = o.wagers.filter((w) => w.status === "OPEN" && w.proposerId !== meId && (!w.accepterId || w.accepterId === meId)).length;
  return (
    <Panel title="Games" right={<a href="/games" target="_blank" rel="noreferrer" className="text-xs text-sky-300 underline">open</a>} defaultOpen={false}>
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-400">Points</span>
        <span className="text-lg font-semibold tabular-nums">{o.points.toLocaleString()}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-sm">
        <span className="text-zinc-400">Bets waiting for you</span>
        <span className={open ? "rounded-full bg-fuchsia-500 px-2 text-xs font-bold text-white" : "text-zinc-500"}>{open}</span>
      </div>
      <div className="mt-2 text-xs text-zinc-400">Poker run {mine?.hand ? `· ${mine.hand.name}` : ""}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {(mine?.cards ?? []).map((c, i) => (
          <span key={i} className={`inline-grid h-8 w-6 place-items-center rounded border border-zinc-300 bg-white text-[11px] font-bold ${c[1] === "H" || c[1] === "D" ? "text-red-600" : "text-zinc-900"}`}>
            {prettyCard(c)}
          </span>
        ))}
        {!mine?.cards.length ? <span className="text-xs text-zinc-500">No cards yet: every sale deals one.</span> : null}
      </div>
    </Panel>
  );
}
