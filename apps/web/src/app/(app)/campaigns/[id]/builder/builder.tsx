"use client";

// Campaign builder, per the owner's design: list management and
// prioritisation (drag to reorder), the cadence flow each list follows, and
// the dialer rules (attempt limits, schedule grid, timezone checking).
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge, Button, inputClass } from "@/components/ui";
import { attachList, launchCampaign, reorderLists, saveRules, saveSchedule, setListCadence } from "./actions";

type Cadence = { id: string; name: string; kind: "FRESH" | "AGED"; instantDial: boolean; instantDelaySeconds: number; maxAttemptsPerDay: number; minGapMinutes: number; rotateDayparts: boolean; preCallSms: string | null; missedCallSms: string | null };
type ListRow = { id: string; name: string; priority: number; status: string; source: string; total: number; dialable: number; cadence: Cadence | null };

interface Props {
  campaign: { id: string; name: string; status: string; dialMode: string; maxAttemptsPerDay: number; listSelection: "STRICT_PRIORITY" | "WEIGHTED_ROUND_ROBIN"; localWindowStart: number; localWindowEnd: number };
  lists: ListRow[];
  cadences: { id: string; name: string; kind: string }[];
  unattached: { id: string; name: string; totalLeads: number }[];
  grid: boolean[][] | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIER = (p: number) => (p <= 1 ? ["Priority 1 - High", "border-emerald-400/40", "text-emerald-300"] : p === 2 ? ["Priority 2 - Medium", "border-amber-400/40", "text-amber-300"] : [`Priority ${p} - Low`, "border-indigo-400/40", "text-indigo-300"]);

function defaultGrid(start: number, end: number): boolean[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => h >= start && h < end));
}

function ruleText(c: Cadence | null, campaignMax: number): string {
  if (!c) return `Campaign dial plans · max ${campaignMax}/day`;
  const parts = [`${c.maxAttemptsPerDay}x daily max`, `${c.minGapMinutes >= 60 ? `${Math.round(c.minGapMinutes / 60)}h` : `${c.minGapMinutes}m`} between dials`];
  if (c.instantDial) parts.unshift("immediate call, real-time trigger");
  if (c.rotateDayparts) parts.push("rotate time-of-day (morning / afternoon / night)");
  return parts.join(", ");
}

export function Builder({ campaign, lists: initialLists, cadences, unattached, grid: initialGrid }: Props) {
  const [lists, setLists] = useState(initialLists);
  const [dragId, setDragId] = useState<string | null>(null);
  const [grid, setGrid] = useState<boolean[][]>(initialGrid ?? defaultGrid(campaign.localWindowStart, campaign.localWindowEnd));
  const [gridOn, setGridOn] = useState(Boolean(initialGrid));
  const [maxAttempts, setMaxAttempts] = useState(campaign.maxAttemptsPerDay);
  const [selection, setSelection] = useState(campaign.listSelection);
  const [selected, setSelected] = useState<string | null>(initialLists[0]?.id ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [paint, setPaint] = useState<boolean | null>(null);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setNotice(null);
      const r = await fn();
      if (!r.ok) setNotice(r.error ?? "That did not work");
    });

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = lists.slice();
    const from = next.findIndex((l) => l.id === dragId);
    const to = next.findIndex((l) => l.id === targetId);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    const ranked = next.map((l, i) => ({ ...l, priority: i + 1 }));
    setLists(ranked);
    setDragId(null);
    act(() => reorderLists(campaign.id, ranked.map((l) => l.id)));
  };

  const toggleCell = (d: number, h: number, value?: boolean) => {
    setGrid((g) => g.map((row, di) => (di === d ? row.map((v, hi) => (hi === h ? (value ?? !v) : v)) : row)));
  };

  const current = lists.find((l) => l.id === selected) ?? null;
  const fresh = lists.filter((l) => l.cadence?.kind === "FRESH").length;

  return (
    <div className="-m-8 min-h-screen bg-[#070b1a] p-6 text-zinc-100">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            CAMPAIGN BUILDER <span className="text-zinc-500">•</span> {campaign.name}
          </h1>
          <div className="mt-1 flex gap-4 text-sm text-zinc-400">
            <span>
              Active lists: <b className="text-zinc-100">{lists.filter((l) => l.status === "ACTIVE").length}</b>
            </span>
            <span>
              Linked automation cadences: <b className="text-zinc-100">{lists.filter((l) => l.cadence).length}</b>
            </span>
            <span>
              Mode: <b className="text-zinc-100">{campaign.dialMode === "RATIO" ? "Ratio" : "Preview"}</b>
            </span>
            <span>
              Status: <b className={campaign.status === "ACTIVE" ? "text-emerald-300" : "text-amber-300"}>{campaign.status}</b>
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/campaigns/${campaign.id}`} className="rounded-md border border-white/15 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10">
            All settings
          </Link>
          <Button onClick={() => act(() => launchCampaign(campaign.id))} disabled={pending} className="bg-emerald-400 text-emerald-950 hover:bg-emerald-300">
            {campaign.status === "ACTIVE" ? "Save & Relaunch" : "Launch Campaign"}
          </Button>
        </div>
      </div>
      {notice ? <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice}</div> : null}

      <div className="grid gap-4 xl:grid-cols-[360px_1fr_340px]">
        {/* 1. Lists */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">1. List management & prioritization</h2>
          <p className="mb-3 text-xs text-zinc-500">Drag to reorder. Top dials first{selection === "WEIGHTED_ROUND_ROBIN" ? ", weighted 3:2:1 across tiers" : ""}.</p>
          <ul className="space-y-2">
            {lists.map((l) => {
              const [label, border, color] = TIER(l.priority);
              return (
                <li
                  key={l.id}
                  draggable
                  onDragStart={() => setDragId(l.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(l.id)}
                  onClick={() => setSelected(l.id)}
                  className={`cursor-grab rounded-xl border-l-4 border border-white/10 bg-black/30 p-3 text-sm ${border} ${selected === l.id ? "ring-1 ring-cyan-400/50" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{l.name}</div>
                      <div className={`text-xs ${color}`}>({label})</div>
                      <div className="text-xs text-zinc-500">{l.source === "POST" ? "Real-time posted leads" : "Uploaded list"}</div>
                    </div>
                    <div className="text-right text-xs">
                      <div className="text-lg font-semibold tabular-nums">{l.total.toLocaleString()}</div>
                      <Badge tone={l.status === "ACTIVE" ? "green" : "amber"}>{l.status.toLowerCase()}</Badge>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">Rule: {ruleText(l.cadence, maxAttempts)}</div>
                  <select
                    value={l.cadence?.id ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      setLists((ls) => ls.map((x) => (x.id === l.id ? { ...x, cadence: id ? ({ ...(x.cadence ?? {}), id, name: cadences.find((c) => c.id === id)?.name ?? "", kind: (cadences.find((c) => c.id === id)?.kind as "FRESH" | "AGED") ?? "AGED" } as Cadence) : null } : x)));
                      act(() => setListCadence(campaign.id, l.id, id));
                    }}
                    className={`${inputClass} mt-2 border-white/10 bg-black/40 py-1 text-xs`}
                  >
                    <option value="">Rule: campaign dial plans</option>
                    {cadences.map((c) => (
                      <option key={c.id} value={c.id}>
                        Rule: {c.name} ({c.kind.toLowerCase()})
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          {unattached.length ? (
            <div className="mt-3 flex gap-2">
              <select id="attach" className={`${inputClass} border-white/10 bg-black/40 py-1 text-xs`} defaultValue="">
                <option value="">Add an existing list…</option>
                {unattached.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.totalLeads})
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                onClick={() => {
                  const el = document.getElementById("attach") as HTMLSelectElement | null;
                  if (el?.value) act(() => attachList(campaign.id, el.value).then((r) => (location.reload(), r)));
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2 text-xs">
            <Link href="/lists" className="rounded-md border border-white/15 px-2 py-1 text-zinc-300 hover:bg-white/10">
              + New list
            </Link>
            <Link href="/cadences" className="rounded-md border border-white/15 px-2 py-1 text-zinc-300 hover:bg-white/10">
              Edit rules (cadences)
            </Link>
          </div>
        </section>

        {/* 2. Workflow */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">2. Workflow designer</h2>
          <p className="mb-4 text-xs text-zinc-500">{current ? `What happens to a lead in "${current.name}". Edit the steps on its cadence profile.` : "Select a list."}</p>
          {current ? <Flow list={current} campaignMax={maxAttempts} /> : null}
        </section>

        {/* 3. Rules */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">3. Dialer rules & timing configuration</h2>
          <div className="space-y-4 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={lists.some((l) => l.cadence?.rotateDayparts)} readOnly className="mt-1 h-4 w-4" />
              <span>
                <span className="font-medium">Rotate time-of-day dialing</span>
                <span className="block text-xs text-zinc-500">On for lists whose rule rotates dayparts: if a dial fails, the next retry rotates between Morning (8:30–11:30), Afternoon (12:30–4:30) and Night (5–7:30 PM), lead&apos;s local time.</span>
              </span>
            </label>

            <div>
              <div className="mb-1 font-medium">Call attempt limits</div>
              <div className="grid grid-cols-[1fr_90px] items-center gap-2 text-xs text-zinc-300">
                <span>Max attempts per day (fresh lists)</span>
                <span className="rounded bg-black/40 px-2 py-1 text-right tabular-nums">{lists.find((l) => l.cadence?.kind === "FRESH")?.cadence?.maxAttemptsPerDay ?? "—"}</span>
                <span>Min interval between dials</span>
                <span className="rounded bg-black/40 px-2 py-1 text-right tabular-nums">{(() => { const m = lists.find((l) => l.cadence)?.cadence?.minGapMinutes; return m ? (m >= 60 ? `${Math.round(m / 60)} hours` : `${m} min`) : "—"; })()}</span>
                <span>Max attempts per day (campaign default)</span>
                <input type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value) || 1)} onBlur={() => act(() => saveRules(campaign.id, { maxAttemptsPerDay: maxAttempts, listSelection: selection }))} className={`${inputClass} border-white/10 bg-black/40 py-1 text-right`} />
                <span>List selection</span>
                <select value={selection} onChange={(e) => { const v = e.target.value as typeof selection; setSelection(v); act(() => saveRules(campaign.id, { maxAttemptsPerDay: maxAttempts, listSelection: v })); }} className={`${inputClass} border-white/10 bg-black/40 py-1 text-xs`}>
                  <option value="STRICT_PRIORITY">Strict</option>
                  <option value="WEIGHTED_ROUND_ROBIN">Weighted</option>
                </select>
              </div>
              {fresh > 0 && maxAttempts > 3 ? <div className="mt-1 text-xs text-amber-300">Above 3/day; state caps (FL, OK, WA, MD, CT, NJ) still win.</div> : null}
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Schedule grid</span>
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <input type="checkbox" checked={gridOn} onChange={(e) => { setGridOn(e.target.checked); act(() => saveSchedule(campaign.id, e.target.checked ? grid : null)); }} className="h-3.5 w-3.5" /> use grid
                </label>
              </div>
              <div className="text-[10px] text-zinc-500">Allowed dialing hours, lead&apos;s local time. Click or drag to paint. Federal and state windows still apply on top.</div>
              <div className={`mt-2 select-none ${gridOn ? "" : "opacity-40"}`} onMouseLeave={() => setPaint(null)} onMouseUp={() => { if (paint !== null) { setPaint(null); act(() => saveSchedule(campaign.id, gridOn ? grid : null)); } }}>
                <div className="grid grid-cols-[32px_repeat(7,1fr)] gap-[2px] text-[9px] text-zinc-500">
                  <div />
                  {DAYS.map((d) => (
                    <div key={d} className="text-center">
                      {d}
                    </div>
                  ))}
                  {Array.from({ length: 16 }, (_, i) => i + 6).map((h) => (
                    <HourRow key={h} h={h} grid={grid} on={gridOn} paint={paint} setPaint={setPaint} toggleCell={toggleCell} />
                  ))}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500/70" /> Allowed dialing hours
                  <span className="ml-2 inline-block h-3 w-3 rounded-sm bg-white/10" /> Blocked
                </div>
              </div>
            </div>

            <label className="flex items-center justify-between rounded-lg bg-black/30 px-3 py-2 text-xs">
              <span>
                Timezone checking <span className="text-zinc-500">(always on: leads without a resolved zone are never dialed)</span>
              </span>
              <span className="relative inline-block h-5 w-9 rounded-full bg-emerald-500">
                <span className="absolute left-[18px] top-0.5 h-4 w-4 rounded-full bg-white" />
              </span>
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

function HourRow({ h, grid, on, paint, setPaint, toggleCell }: { h: number; grid: boolean[][]; on: boolean; paint: boolean | null; setPaint: (v: boolean | null) => void; toggleCell: (d: number, h: number, v?: boolean) => void }) {
  return (
    <>
      <div className="pr-1 text-right leading-4">{h % 12 === 0 ? 12 : h % 12}{h < 12 ? "a" : "p"}</div>
      {DAYS.map((_, d) => {
        const v = grid[d]?.[h] ?? false;
        return (
          <div
            key={d}
            onMouseDown={() => {
              if (!on) return;
              setPaint(!v);
              toggleCell(d, h, !v);
            }}
            onMouseEnter={() => {
              if (on && paint !== null) toggleCell(d, h, paint);
            }}
            className={`h-4 rounded-sm ${v ? "bg-emerald-500/70" : "bg-white/10"} ${on ? "cursor-pointer hover:ring-1 hover:ring-cyan-300/60" : ""}`}
          />
        );
      })}
    </>
  );
}

function Node({ tone, title, children }: { tone: "cyan" | "green" | "amber" | "violet" | "zinc"; title: string; children?: React.ReactNode }) {
  const t = { cyan: "border-cyan-400/40 bg-cyan-400/10", green: "border-emerald-400/40 bg-emerald-400/10", amber: "border-amber-400/40 bg-amber-400/10", violet: "border-violet-400/40 bg-violet-400/10", zinc: "border-white/10 bg-white/5" }[tone];
  return (
    <div className={`rounded-xl border p-3 text-xs ${t}`}>
      <div className="mb-1 font-semibold">{title}</div>
      {children ? <div className="text-zinc-300">{children}</div> : null}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1 text-[10px] text-zinc-500">
      <span className="h-3 w-px bg-white/20" />
      {label ? <span className="rounded bg-black/40 px-1.5 py-0.5">{label}</span> : null}
      <span className="h-3 w-px bg-white/20" />
      <span>▼</span>
    </div>
  );
}

function Flow({ list, campaignMax }: { list: ListRow; campaignMax: number }) {
  const c = list.cadence;
  return (
    <div className="mx-auto max-w-md">
      <Node tone="cyan" title={list.source === "POST" ? "⚡ Trigger: real-time lead posted" : "⚡ Trigger: lead becomes eligible"}>
        {list.source === "POST" ? "Posting API → list, scrubbed at intake" : "Hopper pulls by priority, window and attempts"}
      </Node>
      {c?.preCallSms ? (
        <>
          <Arrow />
          <Node tone="green" title="Action card: SMS preview (pre-call text, from the dialing number)">{c.preCallSms}</Node>
        </>
      ) : null}
      <Arrow label={c?.instantDial ? `Delay: ${c.instantDelaySeconds}s` : c ? `Gap: ${c.minGapMinutes} min${c.rotateDayparts ? ", next daypart" : ""}` : "Campaign dial plan"} />
      <Node tone="amber" title={`☎ Calling · ${c ? `${c.maxAttemptsPerDay} attempts/day` : `max ${campaignMax}/day`}`}>
        Carrier status check · local-presence caller ID · AMD{c?.rotateDayparts ? " · rotates morning / afternoon / evening" : ""}
      </Node>
      <div className="my-2 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-center text-[10px] text-emerald-300">If answered</div>
          <Node tone="green" title="Connected to agent">{c?.instantDial ? "Pending redials for the day cancelled" : "Disposition → recycle or finish"}</Node>
        </div>
        <div>
          <div className="mb-1 text-center text-[10px] text-amber-300">If no answer (voicemail / dropped)</div>
          {c?.missedCallSms ? (
            <Node tone="green" title="1) Send SMS with callback link">{c.missedCallSms}</Node>
          ) : (
            <Node tone="zinc" title="1) No missed-call text">Add one on the cadence profile.</Node>
          )}
          <div className="h-2" />
          <Node tone="violet" title="2) Reschedule">{c ? `After ${c.minGapMinutes >= 60 ? `${Math.round(c.minGapMinutes / 60)} h` : `${c.minGapMinutes} min`}${c.rotateDayparts ? ", in a different window" : ""}, up to ${c.maxAttemptsPerDay}/day` : "Per the campaign dial plan for the lead's age"}</Node>
        </div>
      </div>
      {c?.missedCallSms ? (
        <Node tone="zinc" title="Quick callback page">15 min · 30 min · tomorrow 2 PM · custom time (lead&apos;s zone). Booking cancels the automated redials.</Node>
      ) : null}
    </div>
  );
}
