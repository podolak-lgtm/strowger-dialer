"use client";

// Supervisor dashboards, per the owner's designs:
//   ?view=agents    real-time agent monitoring: queue, listen / whisper /
//                   barge / takeover, action history, team performance
//   ?view=campaign  campaign performance: KPI strip, call volume, agent table
import { createJambonzClient } from "@jambonz/client-sdk-web";
import { io } from "socket.io-client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { floorStats, superviseCurrent, superviseMode, superviseStart, superviseStop, superviseTakeover, type FloorAgent, type FloorStats, type Supervision, type SuperviseMode } from "./actions";

type JambonzClient = ReturnType<typeof createJambonzClient>;

interface Props {
  me: { id: string; name: string; role: string };
  view: "agents" | "campaign";
  initialCampaignId: string | null;
  engineUrl: string;
  rtToken: string;
  sip: { server: string; realm: string; username: string; password: string } | null;
}

const STATE_TONE: Record<string, string> = {
  READY: "bg-emerald-500/20 text-emerald-300",
  ON_CALL: "bg-sky-500/20 text-sky-300",
  WRAP_UP: "bg-fuchsia-500/20 text-fuchsia-300",
  PAUSED: "bg-amber-500/20 text-amber-300",
  LOGGED_IN: "bg-zinc-500/20 text-zinc-300",
  LOGGED_OUT: "bg-zinc-700/30 text-zinc-500",
};
const STATE_LABEL: Record<string, string> = { READY: "Active", ON_CALL: "In-Call", WRAP_UP: "Wrapup", PAUSED: "Break", LOGGED_IN: "Idle", LOGGED_OUT: "Offline" };

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function hm(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m ${String(Math.floor(sec % 60)).padStart(2, "0")}s`;
}

function Panel({ title, children, right, className = "" }: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.04] p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-100">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Spark({ values, color = "#22d3ee" }: { values: number[]; color?: string }) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${40 - (v / max) * 36}`).join(" ");
  return (
    <svg viewBox="0 0 100 44" preserveAspectRatio="none" className="h-16 w-full">
      <defs>
        <linearGradient id={`g-${color}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.5" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,44 ${pts} 100,44`} fill={`url(#g-${color})`} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function FloorConsole({ me, view, initialCampaignId, engineUrl, rtToken, sip }: Props) {
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId);
  const [stats, setStats] = useState<FloorStats | null>(null);
  const [sup, setSup] = useState<Supervision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phone, setPhone] = useState<"off" | "registered" | "error">("off");
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const clientRef = useRef<JambonzClient | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [st, su] = await Promise.all([floorStats(campaignId), superviseCurrent()]);
      setStats(st);
      setSup(su);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [campaignId]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 10_000);
    const tk = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      clearInterval(tk);
    };
  }, [refresh]);

  useEffect(() => {
    const sock = io(engineUrl, { path: "/rt", auth: { token: rtToken }, transports: ["websocket"] });
    const bump = () => void refresh();
    sock.on("floor:agent", bump);
    sock.on("floor:call", bump);
    sock.on("floor:supervision", (s: Supervision) => {
      if (s.supervisorId === me.id) setSup(s.ended ? null : s);
    });
    return () => {
      sock.disconnect();
    };
  }, [engineUrl, rtToken, me.id, refresh]);

  // The supervisor's softphone auto-answers the supervision leg the engine rings.
  useEffect(() => {
    if (!sip) return;
    const t = setTimeout(async () => {
      try {
        const client = createJambonzClient({ server: sip.server, username: sip.username, password: sip.password, realm: sip.realm || undefined, displayName: `${me.name} (supervisor)` });
        client.on("registered", () => setPhone("registered"));
        client.on("registrationFailed", () => setPhone("error"));
        client.on("incoming", (call: { answer: () => void }) => call.answer());
        await client.connect();
        clientRef.current = client;
      } catch {
        setPhone("error");
      }
    }, 0);
    return () => {
      clearTimeout(t);
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [sip, me.name]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string } | { ok: boolean }>) =>
    start(async () => {
      setNotice(null);
      const r = await fn();
      if (!r.ok) setNotice(("error" in r && r.error) || "That did not work");
      void refresh();
    });

  const monitor = (agentId: string, mode: SuperviseMode) => act(() => superviseStart(agentId, mode));
  const setMode = (mode: SuperviseMode) => act(() => superviseMode(mode));
  const takeover = () => {
    if (!confirm("Take over this call? The agent is dropped and the caller stays with you.")) return;
    act(() => superviseTakeover());
  };
  const stop = () => act(() => superviseStop());

  const watched = stats?.agents.find((a) => a.userId === sup?.agentId) ?? null;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-16 flex-col items-center gap-3 border-r border-white/10 bg-black/20 py-4">
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-lg font-black text-white">S</div>
        {[
          ["agents", "Agent monitoring", "☎"],
          ["campaign", "Campaign monitor", "▦"],
        ].map(([key, label, glyph]) => (
          <a key={key} href={`/floor?view=${key}${campaignId ? `&campaign=${campaignId}` : ""}`} title={label} className={`grid h-10 w-10 place-items-center rounded-xl text-lg ${view === key ? "bg-white/15 text-cyan-300" : "text-zinc-400 hover:bg-white/10"}`}>
            {glyph}
          </a>
        ))}
        <div className="flex-1" />
        <a href="/dashboard" title="Back" className="grid h-10 w-10 place-items-center rounded-xl text-zinc-400 hover:bg-white/10">
          ⎋
        </a>
      </aside>

      <main className="flex-1 p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              SUPERVISOR DASHBOARD <span className="text-zinc-500">•</span> {view === "agents" ? "Real-Time Agent Monitoring" : "Campaign Performance & Real-Time Monitoring"}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-zinc-400">
              <select value={campaignId ?? ""} onChange={(e) => setCampaignId(e.target.value || null)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-zinc-100">
                <option value="" className="bg-zinc-900">
                  All campaigns
                </option>
                {(stats?.campaigns ?? []).map((c) => (
                  <option key={c.id} value={c.id} className="bg-zinc-900">
                    {c.name} · {c.status.toLowerCase()}
                  </option>
                ))}
              </select>
              <span className={`rounded-full px-2 py-0.5 text-xs ${phone === "registered" ? "bg-emerald-500/20 text-emerald-300" : phone === "error" ? "bg-red-500/20 text-red-300" : "bg-white/10 text-zinc-400"}`}>
                {sip ? (phone === "registered" ? "your line is registered" : phone === "error" ? "line error" : "registering…") : "no softphone line: listen/whisper/barge need one"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-6 text-center">
            {[
              [view === "agents" ? "Active Calls" : "Active Campaigns", view === "agents" ? stats?.inProgress : stats?.activeCampaigns],
              [view === "agents" ? "Agents On Call" : "Total Agents Active", view === "agents" ? stats?.agentsOnCall : stats?.agentsActive],
              [view === "agents" ? "Queue Wait" : "Calls in Progress", view === "agents" ? mmss(stats?.queueWaitSeconds ?? 0) : stats?.inProgress],
            ].map(([label, v]) => (
              <div key={String(label)}>
                <div className="text-xs text-zinc-500">{label}</div>
                <div className="text-xl font-semibold tabular-nums">{v ?? "—"}</div>
              </div>
            ))}
            <div className="flex items-center gap-2 border-l border-white/10 pl-4 text-left">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-sm font-bold">{me.name.slice(0, 1).toUpperCase()}</div>
              <div className="text-xs">
                <div className="font-medium">{me.name}</div>
                <div className="text-zinc-500">({me.role})</div>
              </div>
            </div>
          </div>
        </div>

        {notice ? <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice}</div> : null}

        {view === "agents" ? (
          <div className="grid gap-4 xl:grid-cols-[320px_1fr_300px]">
            <div className="space-y-4">
              <Panel title="Today's Stats">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ["Total Calls", stats?.totalDials, stats?.volume ?? [], "#3b82f6"],
                    ["Total Sales", stats?.sales, stats?.volume.map((v, i) => (i % 3 === 0 ? v : v / 2)) ?? [], "#22c55e"],
                    ["Transfers", stats?.agents.reduce((n, a) => n + a.transfers, 0), stats?.volume.map((v) => v / 3) ?? [], "#ef4444"],
                  ].map(([label, v, series, color]) => (
                    <div key={String(label)}>
                      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
                      <div className="text-2xl font-semibold tabular-nums">{(v as number | undefined) ?? "—"}</div>
                      <Spark values={series as number[]} color={color as string} />
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Agent Queue & Activity" right={<span className="text-xs text-zinc-500">{stats?.agents.length ?? 0} agents</span>}>
                <ul className="space-y-2">
                  {(stats?.agents ?? []).map((a) => (
                    <AgentRow key={a.userId} a={a} now={now} active={sup?.agentId === a.userId} onMonitor={monitor} disabled={pending} />
                  ))}
                  {stats && stats.agents.length === 0 ? <li className="text-sm text-zinc-500">Nobody is logged in.</li> : null}
                </ul>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel title={`Active Call Monitoring${watched ? ` - ${watched.name}` : ""}`}>
                {sup && watched ? (
                  <>
                    <div className="mb-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-center">
                      <div className="text-lg font-semibold text-emerald-300">
                        {sup.mode === "LISTEN" ? "MONITORING LIVE CALL" : sup.mode === "WHISPER" ? "COACHING AGENT" : "BARGED IN"} <span className="ml-2 text-sm text-zinc-400">⏱ {mmss((now - sup.since) / 1000)}</span>
                      </div>
                      <div className="text-sm text-zinc-400">{watched.leadName ? `Customer: ${watched.leadName}` : watched.state === "ON_CALL" ? "Customer on the line" : `Agent is ${STATE_LABEL[watched.state]?.toLowerCase()}`}</div>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {(
                        [
                          ["LISTEN", "Listen", "(Silent)"],
                          ["WHISPER", "Whisper", "(Coach agent)"],
                          ["BARGE", "Barge In", "(Join call)"],
                        ] as const
                      ).map(([mode, label, sub]) => (
                        <button key={mode} onClick={() => setMode(mode)} disabled={pending} className={`rounded-xl border px-3 py-3 text-sm ${sup.mode === mode ? "border-orange-400 bg-orange-400/10 text-orange-200" : "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"}`}>
                          <div className="font-semibold">{label}</div>
                          <div className="text-[10px] text-zinc-400">{sub}</div>
                        </button>
                      ))}
                      <button onClick={takeover} disabled={pending} className="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-zinc-200 hover:bg-white/10">
                        <div className="font-semibold">Takeover</div>
                        <div className="text-[10px] text-zinc-400">(Replace agent)</div>
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-orange-300">CAUTION: Barging in makes your audio live to both {watched.name.split(" ")[0]} and the customer.</p>
                    <button onClick={stop} className="mt-3 text-xs text-zinc-400 underline">
                      Stop monitoring
                    </button>
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">Pick an agent and choose Listen, Whisper or Barge. Your softphone answers automatically.</div>
                )}
              </Panel>
              <Panel title="Call Supervision Console">
                <div className="space-y-3 text-sm text-zinc-400">
                  <div className="rounded-lg bg-black/30 p-3">
                    <div className="mb-1 flex items-center justify-between text-zinc-200">
                      <span>{watched?.name ?? "Agent"}</span>
                      <span className="text-xs">{watched?.state === "ON_CALL" ? mmss((now - watched.since) / 1000) : "—"}</span>
                    </div>
                    <Spark values={[2, 5, 3, 8, 6, 9, 4, 7, 5, 8, 3, 6]} color="#22d3ee" />
                    <div className="text-xs">Live transcription arrives with the texting phase.</div>
                  </div>
                  <div className="rounded-lg bg-black/30 p-3">
                    <div className="mb-1 flex items-center justify-between text-zinc-200">
                      <span>Customer {watched?.leadName ?? ""}</span>
                      <span className="font-mono text-xs">{watched?.leadPhone ? watched.leadPhone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3") : ""}</span>
                    </div>
                    <Spark values={[4, 3, 6, 2, 7, 5, 8, 4, 6, 3, 7, 5]} color="#f87171" />
                  </div>
                </div>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel title="Action History">
                <ul className="space-y-1 text-xs text-zinc-400">
                  {(stats?.history ?? []).map((h, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-zinc-600">{new Date(h.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      <span>
                        {h.actor}: {h.action}
                        {h.target ? ` → ${h.target}` : ""}
                      </span>
                    </li>
                  ))}
                  {stats && stats.history.length === 0 ? <li>No supervisor actions yet.</li> : null}
                </ul>
              </Panel>
              <Panel title="Team Performance">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-zinc-500">
                    <tr>
                      <th className="py-1">Daily</th>
                      <th>Total</th>
                      <th>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stats?.team ?? []).map((t) => (
                      <tr key={t.label} className="border-t border-white/5">
                        <td className="py-1.5">{t.label}</td>
                        <td className="tabular-nums">{t.total}</td>
                        <td className="tabular-nums text-emerald-300">{t.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
              <Panel title="Campaign Statistics & KPI Dashboard">
                <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
                  {[
                    ["Total Dials", stats?.totalDials],
                    ["Connected Calls", stats?.connected],
                    ["Conversations", stats?.conversations],
                    ["Success Rate", stats ? `${stats.successRate}%` : undefined],
                    ["Total Sales", stats?.sales],
                    ["Dropped/No Answer", stats?.dropped],
                  ].map(([label, v]) => (
                    <div key={String(label)}>
                      <div className="text-xs text-zinc-500">{label}</div>
                      <div className="text-3xl font-semibold tabular-nums">{v ?? "—"}</div>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Live-running Call Volume Chart">
                <Spark values={stats?.volume ?? []} color="#22d3ee" />
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>60 min ago</span>
                  <span>now</span>
                </div>
              </Panel>
            </div>
            <Panel title="Agent Performance & Activity Monitor">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      {["Agent", "Status", "Campaign", "Total Dials", "Calls Handled", "Talk Time", "Idle Time", "Transfers", "Sales / Conversions", "Monitoring Actions"].map((h) => (
                        <th key={h} className="px-2 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {(stats?.agents ?? []).map((a) => (
                      <tr key={a.userId}>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-xs font-bold">{a.name.slice(0, 1)}</span>
                            {a.name}
                            <span className={`h-2 w-2 rounded-full ${a.state === "ON_CALL" || a.state === "READY" ? "bg-emerald-400" : "bg-amber-400"}`} />
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_TONE[a.state]}`}>{STATE_LABEL[a.state] ?? a.state}</span>
                        </td>
                        <td className="px-2 py-2 text-zinc-300">{a.campaignName ?? "—"}</td>
                        <td className="px-2 py-2 tabular-nums">{a.dials}</td>
                        <td className="px-2 py-2 tabular-nums">{a.handled}</td>
                        <td className="px-2 py-2 tabular-nums">{hm(a.talkSeconds)}</td>
                        <td className="px-2 py-2 tabular-nums">{a.state === "READY" || a.state === "LOGGED_IN" ? mmss((now - a.since) / 1000) : "—"}</td>
                        <td className="px-2 py-2 tabular-nums">{a.transfers}</td>
                        <td className="px-2 py-2">
                          <span className={`rounded px-2 py-0.5 text-xs ${a.sales ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-500"}`}>{a.sales ? `${a.sales} sales` : "0"}</span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            {(["LISTEN", "WHISPER", "BARGE"] as const).map((m) => (
                              <button key={m} onClick={() => monitor(a.userId, m)} disabled={pending || a.state !== "ON_CALL"} className="rounded border border-white/10 px-2 py-0.5 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-40">
                                {m === "LISTEN" ? "Listen" : m === "WHISPER" ? "Whisper" : "Barge"}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {stats && stats.agents.length === 0 ? <div className="p-6 text-center text-sm text-zinc-500">Nobody is logged in.</div> : null}
              </div>
            </Panel>
          </div>
        )}
      </main>
    </div>
  );
}

function AgentRow({ a, now, active, onMonitor, disabled }: { a: FloorAgent; now: number; active: boolean; onMonitor: (id: string, m: SuperviseMode) => void; disabled: boolean }) {
  const canMonitor = a.state === "ON_CALL";
  return (
    <li className={`rounded-xl border p-2 ${active ? "border-emerald-400/50 bg-emerald-400/5" : "border-white/10 bg-white/5"}`}>
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-fuchsia-500 to-cyan-400 text-xs font-bold">{a.name.slice(0, 1)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium">{a.name}</span>
            <span className={`h-2 w-2 rounded-full ${a.state === "ON_CALL" || a.state === "READY" ? "bg-emerald-400" : a.state === "PAUSED" ? "bg-amber-400" : "bg-zinc-500"}`} />
          </div>
          <div className="text-xs text-zinc-400">
            {STATE_LABEL[a.state]} ({mmss((now - a.since) / 1000)}) · {a.dials} calls, {a.sales} sales
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${STATE_TONE[a.state]}`}>{a.state === "ON_CALL" ? "Active" : STATE_LABEL[a.state]}</span>
      </div>
      <div className="mt-2 flex justify-end gap-1">
        {(["LISTEN", "WHISPER", "BARGE"] as const).map((m) => (
          <button key={m} onClick={() => onMonitor(a.userId, m)} disabled={disabled || !canMonitor} className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10 disabled:opacity-30">
            {m === "LISTEN" ? "Listen" : m === "WHISPER" ? "Whisper" : "Barge"}
          </button>
        ))}
      </div>
    </li>
  );
}
