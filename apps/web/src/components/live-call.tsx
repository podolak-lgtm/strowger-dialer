"use client";

// Live transcription and agent assist on screen (engine assist/live.ts):
// the chat-style transcript, the compliance banners, the "Say this" and
// "Suggested next line" cards and the script checklist. Used by the agent
// console (both screens) and by the floor while a supervisor listens,
// whispers or barges. One hook holds what the socket sent for the call on
// screen; a reload or a late start picks up the finals so far from the Call.
import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Speaker, TranscriptTurn } from "@strowger/shared/assist";
import type { LiveAlert } from "@strowger/shared/compliance";
import { liveCallState } from "@/lib/live-call-actions";

export type Suggestion = { id: string; status: "thinking" | "streaming" | "done" | "failed"; lines: string[]; tone: string | null; heard?: string; at: number };
export type SuggestedDisposition = { dispositionId: string; code: string; label: string; reason: string };

export interface LiveView {
  callId: string | null;
  turns: TranscriptTurn[];
  partial: Partial<Record<Speaker, { text: string; at: number }>>;
  status: { on: boolean; agentSide: boolean; message: string | null } | null;
  rebuttal: { heard: string; objection: string; response: string; at: number } | null;
  suggestion: Suggestion | null;
  script: { steps: Array<{ index: number; title: string }>; covered: number[]; next: number | null } | null;
  alerts: LiveAlert[];
  /** Rules the agent has since satisfied (the disclosure, heard late). */
  cleared: string[];
  summary: string | null;
  notes: string | null;
  suggestedDisposition: SuggestedDisposition | null;
  restored: boolean;
}

const empty = (callId: string | null): LiveView => ({ callId, turns: [], partial: {}, status: null, rebuttal: null, suggestion: null, script: null, alerts: [], cleared: [], summary: null, notes: null, suggestedDisposition: null, restored: false });

type Ev = { callId: string; agentId?: string };

/**
 * What the engine streams for the call on screen. `agentId` filters (the
 * floor watches one agent; the console gets only its own events anyway).
 * The view resets whenever the call changes.
 */
export function useLiveCall(sock: Socket | null, callId: string | null, agentId?: string | null): LiveView {
  const [v, setV] = useState<LiveView>(() => empty(callId));
  const filter = useRef<string | null | undefined>(agentId);
  useEffect(() => {
    filter.current = agentId;
  }, [agentId]);

  useEffect(() => {
    if (!sock) return;
    const ok = (p: Ev) => !filter.current || !p.agentId || p.agentId === filter.current;
    // Every event moves the view to its call; a new call starts clean.
    const on = <T extends Ev>(event: string, fn: (cur: LiveView, p: T) => LiveView) => {
      const h = (p: T) => {
        if (!ok(p)) return;
        setV((cur) => fn(cur.callId === p.callId ? cur : empty(p.callId), p));
      };
      sock.on(event, h);
      return () => void sock.off(event, h);
    };
    const offs = [
      on<Ev & { speaker: Speaker; text: string; at: number }>("transcript:partial", (cur, p) => ({ ...cur, partial: { ...cur.partial, [p.speaker]: { text: p.text, at: p.at } } })),
      on<Ev & { speaker: Speaker; text: string; at: number }>("transcript:final", (cur, p) => {
        const partial = { ...cur.partial };
        delete partial[p.speaker];
        return { ...cur, partial, turns: [...cur.turns, { speaker: p.speaker, text: p.text, at: p.at }].slice(-400) };
      }),
      on<Ev & { on: boolean; agentSide: boolean; message: string | null }>("transcript:status", (cur, p) => ({ ...cur, status: { on: p.on, agentSide: p.agentSide, message: p.message }, partial: p.on ? cur.partial : {} })),
      on<Ev & { heard: string; objection: string; response: string; at: number }>("assist:rebuttal", (cur, p) => ({ ...cur, rebuttal: { heard: p.heard, objection: p.objection, response: p.response, at: p.at } })),
      on<Ev & Suggestion>("assist:suggestion", (cur, p) => {
        if (cur.suggestion && cur.suggestion.id !== p.id && p.at < cur.suggestion.at) return cur;
        const lines = p.lines.length ? p.lines : cur.suggestion?.id === p.id ? cur.suggestion.lines : [];
        return { ...cur, suggestion: { id: p.id, status: p.status, lines, tone: p.tone ?? null, heard: p.heard ?? (cur.suggestion?.id === p.id ? cur.suggestion.heard : undefined), at: p.at } };
      }),
      on<Ev & { steps: Array<{ index: number; title: string }>; covered: number[]; next: number | null }>("assist:script", (cur, p) => ({ ...cur, script: { steps: p.steps, covered: p.covered, next: p.next } })),
      on<Ev & LiveAlert>("compliance:alert", (cur, p) => ({ ...cur, alerts: [...cur.alerts, { rule: p.rule, severity: p.severity, message: p.message, phrase: p.phrase, text: p.text, at: p.at }].slice(-20), cleared: cur.cleared.filter((r) => r !== p.rule) })),
      on<Ev & { rule: string }>("compliance:clear", (cur, p) => ({ ...cur, cleared: [...cur.cleared, p.rule] })),
      on<Ev & { summary: string | null; notes: string | null; suggestion: SuggestedDisposition | null }>("call:summary", (cur, p) => ({ ...cur, summary: p.summary, notes: p.notes, suggestedDisposition: p.suggestion })),
    ];
    return () => offs.forEach((f) => f());
  }, [sock]);

  // Pick up what was said before this screen started listening (reload, a supervisor joining late).
  const view = v.callId === callId ? v : empty(callId);
  const needsRestore = Boolean(callId) && !view.restored;
  useEffect(() => {
    if (!callId || !needsRestore) return;
    let gone = false;
    const t = setTimeout(() => {
      void liveCallState(callId)
        .then((st) => {
          if (gone) return;
          setV((cur) => {
            const base = cur.callId === callId ? cur : empty(callId);
            if (!st) return { ...base, restored: true };
            // Finals that came over the socket meanwhile are newer than the stored ones.
            const seen = new Set(base.turns.map((x) => `${x.speaker}:${x.at}`));
            const turns = [...st.transcript.filter((x) => !seen.has(`${x.speaker}:${x.at}`)), ...base.turns].sort((a, b) => a.at - b.at);
            return { ...base, turns, alerts: base.alerts.length ? base.alerts : st.alerts, summary: base.summary ?? st.summary, suggestedDisposition: base.suggestedDisposition ?? st.suggestion, restored: true };
          });
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [callId, needsRestore]);

  return view;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Chat-style transcript: customer left in cyan, agent right in violet; interim words grey until final; follows the live end unless scrolled up. */
export function TranscriptPanel({ view, height = "h-56", agentLabel = "Agent" }: { view: LiveView; height?: string; agentLabel?: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const count = view.turns.length + Object.keys(view.partial).length;
  const lastPartial = (view.partial.CUSTOMER?.text ?? "") + (view.partial.AGENT?.text ?? "");
  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [count, lastPartial, follow]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  const jump = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollow(true);
  };
  const bubble = (speaker: Speaker, text: string, at: number, interim: boolean, key: string) => (
    <div key={key} className={`flex ${speaker === "AGENT" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${speaker === "AGENT" ? "rounded-br-sm bg-violet-500/15 text-violet-100" : "rounded-bl-sm bg-cyan-500/15 text-cyan-50"} ${interim ? "italic opacity-60" : ""}`}>
        <div className={`mb-0.5 text-[10px] uppercase tracking-wide ${speaker === "AGENT" ? "text-violet-300/80" : "text-cyan-300/80"}`}>
          {speaker === "AGENT" ? agentLabel : "Customer"} · {interim ? "…" : time(at)}
        </div>
        {text}
      </div>
    </div>
  );
  return (
    <div className="relative">
      <div ref={box} onScroll={onScroll} className={`${height} space-y-1.5 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2`} aria-live="polite">
        {view.turns.length === 0 && !view.partial.CUSTOMER && !view.partial.AGENT ? <p className="p-2 text-xs text-zinc-500">{view.status?.on === false ? "Transcription stopped." : "Listening… words appear here as they are spoken."}</p> : null}
        {view.turns.map((t, i) => bubble(t.speaker, t.text, t.at, false, `${t.speaker}-${t.at}-${i}`))}
        {view.partial.CUSTOMER ? bubble("CUSTOMER", view.partial.CUSTOMER.text, view.partial.CUSTOMER.at, true, "p-c") : null}
        {view.partial.AGENT ? bubble("AGENT", view.partial.AGENT.text, view.partial.AGENT.at, true, "p-a") : null}
      </div>
      {!follow ? (
        <button onClick={jump} className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-cyan-500 px-3 py-1 text-xs font-semibold text-cyan-950 shadow">
          Jump to live ↓
        </button>
      ) : null}
      {view.status?.message ? <p className="mt-1 text-[11px] text-amber-300/90">{view.status.message}</p> : null}
    </div>
  );
}

/** Red disclosure banner while it is owed; amber lines for banned phrases said on this call. */
export function ComplianceBanner({ view }: { view: LiveView }) {
  const disclosure = view.alerts.some((a) => a.rule === "disclosure_missing") && !view.cleared.includes("disclosure_missing");
  const banned = view.alerts.filter((a) => a.rule === "banned_phrase").slice(-3);
  if (!disclosure && banned.length === 0) return null;
  return (
    <div className="mb-3 space-y-1.5">
      {disclosure ? (
        <div role="alert" className="animate-pulse rounded-xl border-2 border-red-500 bg-red-600/90 px-3 py-2 text-sm font-bold uppercase tracking-wide text-white">
          Give the recording disclosure now
        </div>
      ) : null}
      {banned.map((a) => (
        <div key={`${a.at}-${a.phrase}`} role="alert" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100">
          ⚠ {a.message}
        </div>
      ))}
    </div>
  );
}

/** "Say this" (a rebuttal from the library) and "Suggested next line" (the AI) cards. */
export function AssistCards({ view }: { view: LiveView }) {
  const s = view.suggestion;
  const showRebuttal = view.rebuttal && (!s || view.rebuttal.at >= s.at);
  if (!view.rebuttal && !s) return null;
  return (
    <div className="space-y-2">
      {showRebuttal && view.rebuttal ? (
        <div className="rounded-xl border border-emerald-400/40 bg-emerald-400/10 p-3">
          <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-emerald-300">
            <span>Say this</span>
            <span className="normal-case text-emerald-200/70">“{view.rebuttal.objection}”</span>
          </div>
          <p className="text-sm text-emerald-50">{view.rebuttal.response}</p>
        </div>
      ) : null}
      {s && !(showRebuttal && s.status === "failed") ? (
        <div className={`rounded-xl border p-3 ${s.status === "failed" ? "border-white/10 bg-white/5" : "border-sky-400/40 bg-sky-400/10"}`}>
          <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-sky-300">
            <span>Suggested next line</span>
            {s.tone ? <span className="rounded-full bg-sky-400/20 px-2 normal-case text-sky-100">tone: {s.tone}</span> : s.status === "thinking" || s.status === "streaming" ? <span className="normal-case text-sky-200/70">writing…</span> : null}
          </div>
          {s.lines.length ? (
            <ul className="space-y-1 text-sm text-sky-50">
              {s.lines.map((l, i) => (
                <li key={i}>“{l}”</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-400">{s.status === "failed" ? "No suggestion this time." : "Thinking…"}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The campaign script as steps; the agent's words tick them off; the next one is highlighted. */
export function ScriptChecklist({ view }: { view: LiveView }) {
  const sc = view.script;
  if (!sc || sc.steps.length === 0) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-zinc-400">
        <span>Script progress</span>
        <span>
          {sc.covered.length}/{sc.steps.length}
        </span>
      </div>
      <ol className="space-y-1 text-sm">
        {sc.steps.map((st) => {
          const done = sc.covered.includes(st.index);
          const next = sc.next === st.index;
          return (
            <li key={st.index} className={`flex items-start gap-2 rounded-md px-1.5 py-0.5 ${next ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-400/40" : done ? "text-zinc-500" : "text-zinc-300"}`}>
              <span aria-hidden className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${done ? "border-emerald-400 bg-emerald-400/30 text-emerald-100" : next ? "border-cyan-300" : "border-zinc-600"}`}>
                {done ? "✓" : ""}
              </span>
              <span className={done ? "line-through decoration-zinc-600" : ""}>{st.title}</span>
              {next ? <span className="ml-auto shrink-0 text-[10px] uppercase text-cyan-300">next</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Everything live on one call, for a column: compliance, assist, transcript, script. */
export function LiveCallPanel({ view, assist = true, height, agentLabel }: { view: LiveView; assist?: boolean; height?: string; agentLabel?: string }) {
  return (
    <div className="space-y-3">
      <ComplianceBanner view={view} />
      {assist ? <AssistCards view={view} /> : null}
      <TranscriptPanel view={view} height={height} agentLabel={agentLabel} />
      {assist ? <ScriptChecklist view={view} /> : null}
    </div>
  );
}
