"use client";

// The poker run as the owner drew it (6 Nov, "7 card, use this style
// graphics, more sexy!"): a dark navy card in a glowing violet-to-gold frame
// with the player's seven slots, and under it the table. Shared by the agent
// console's Games panel and /games. Pure display: the engine ranks the rows
// (best hand, then cards held, then contacts) and works out the progress
// toward the next card; `now` comes from the caller so render stays pure.
import { ordinal, timeLeft } from "@strowger/shared/games";
import { useState } from "react";
import type { RunSummary, StandingRow } from "@/lib/games-actions";
import { PlayingCard } from "./playing-card";

/** Dot-grid texture on the navy card. */
const DOTS = "bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1.2px)] [background-size:12px_12px]";

function statusPill(run: RunSummary, now: number): { text: string; cls: string } {
  if (run.status === "ENDED") return { text: "Ended", cls: "border-zinc-500/60 bg-zinc-800/70 text-zinc-300" };
  if (now < new Date(run.startsAt).getTime()) return { text: "Upcoming", cls: "border-amber-400/60 bg-amber-950/60 text-amber-200" };
  if (now >= new Date(run.endsAt).getTime()) return { text: "Closing", cls: "border-amber-400/60 bg-amber-950/60 text-amber-200" };
  return { text: "Active", cls: "border-sky-500/70 bg-[#0d2147] text-sky-300" };
}

/** A dark glassy slot with a lock, ringed in violet by the progress toward the next card. */
function LockedSlot({ fraction, next, label }: { fraction: number; next: boolean; label: string }) {
  const r = 15;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <span role="img" aria-label={label} title={label} className={`relative flex aspect-[5/7] w-full items-center justify-center overflow-hidden rounded-[8%] border bg-[linear-gradient(160deg,rgba(255,255,255,0.10),rgba(255,255,255,0.02)_45%,rgba(0,0,0,0.25))] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_6px_14px_-6px_rgba(0,0,0,0.8)] ${next ? "border-violet-400/35" : "border-white/10"}`}>
      <span className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/[0.07] to-transparent" aria-hidden />
      <svg viewBox="0 0 40 40" className={`w-[70%] ${next ? "" : "opacity-60"}`} aria-hidden>
        <circle cx="20" cy="20" r={r + 3.5} fill="rgba(10,12,30,0.55)" />
        <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="3" />
        {next && pct > 0 ? (
          <circle cx="20" cy="20" r={r} fill="none" stroke="url(#sw-ring)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${pct * circ} ${circ}`} transform="rotate(-90 20 20)" className="transition-[stroke-dasharray] duration-700 motion-reduce:transition-none" style={{ filter: "drop-shadow(0 0 2px rgba(167,139,250,0.9))" }} />
        ) : null}
        <defs>
          <linearGradient id="sw-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <g fill="#b9bdd0">
          <path d="M16.2 18.4 V16.2 a3.8 3.8 0 0 1 7.6 0 V18.4" fill="none" stroke="#b9bdd0" strokeWidth="1.8" />
          <rect x="14.4" y="18.2" width="11.2" height="8.6" rx="1.8" />
        </g>
        <circle cx="20" cy="22.3" r="1.2" fill="#1a1d33" />
      </svg>
    </span>
  );
}

/** The run card: header, name and status, seven slots, the best hand in gold. `row` is whose hand to show
 *  (the viewer's; managers who do not play see the leader's with `handTitle`). `fresh` is a card being dealt
 *  right now: it flips into its slot. */
export function PokerRunCard({ run, row, now, handTitle = "Your Best Hand", fresh, children }: { run: RunSummary; row: StandingRow | null; now: number; handTitle?: string; fresh?: string | null; children?: React.ReactNode }) {
  const max = run.handMax || 7;
  const cards = row?.cards ?? [];
  const makers = row?.hand?.makers ?? [];
  const best = row?.hand?.cards ?? [];
  const pill = statusPill(run, now);
  const progress = row?.progress ?? { since: 0, perCard: run.outcomesPerCard, fraction: 0, full: false };
  const per = run.outcomesPerCard || 1;
  const unit = run.qualifies === "CONTACT" ? (per === 1 ? "contact" : "contacts") : run.qualifies === "CODES" ? (per === 1 ? "outcome" : "outcomes") : per === 1 ? "sale" : "sales";
  const slots = Array.from({ length: max }, (_, i) => cards[i] ?? null);
  const full = cards.length >= max;
  return (
    <div className="@container rounded-[20px] bg-gradient-to-br from-violet-500 via-fuchsia-500/50 to-amber-400 p-[1.5px] shadow-[0_0_22px_-6px_rgba(139,92,246,0.7),0_0_30px_-10px_rgba(251,191,36,0.6)]">
      <div className={`rounded-[19px] bg-[#12142a] p-3.5 @sm:p-5 ${DOTS}`}>
        <div className="flex items-baseline gap-1.5 whitespace-nowrap @sm:gap-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#ff6a3d] @sm:text-xs @sm:tracking-[0.2em]">Poker run</span>
          <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-400 @sm:text-[10px]">7 card stud</span>
          <span className="ml-auto min-w-0 truncate text-[11px] text-zinc-300 @sm:text-xs">{run.status === "ENDED" ? "ended" : timeLeft(run.endsAt, new Date(now))}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-xl font-extrabold tracking-tight text-white @sm:text-2xl" title={run.name}>
            {run.name}
          </h3>
          <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold @sm:text-xs ${pill.cls}`}>{pill.text}</span>
        </div>
        {run.prize ? <div className="mt-1 truncate text-xs text-amber-200/90">Prize: {run.prize}</div> : null}

        <div className="mt-3 grid grid-cols-5 gap-1.5 @sm:gap-2.5" aria-label={`${cards.length} of ${max} cards`}>
          {slots.map((c, i) =>
            c ? (
              <span key={c} className={c === fresh ? "[perspective:600px]" : ""}>
                <span className={`block ${c === fresh ? "sw-deal-flip" : ""}`}>
                  <PlayingCard card={c} size="fluid" lifted={makers.includes(c)} dim={cards.length > 5 && best.length > 0 && !best.includes(c)} />
                </span>
              </span>
            ) : (
              <LockedSlot
                key={`slot-${i}`}
                next={i === cards.length}
                fraction={i === cards.length ? progress.fraction : 0}
                label={i === cards.length ? (per > 1 ? `Next card: ${progress.since} of ${per} ${unit}` : `Next card on the next ${unit}`) : "Locked slot"}
              />
            ),
          )}
        </div>

        <div className="mt-3 text-sm @sm:text-base">
          <span className="text-zinc-300">{handTitle}: </span>
          <b className="font-extrabold text-amber-300">{row?.hand?.label ?? "No cards yet"}</b>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-500">
          {full ? <span className="font-semibold text-violet-300">Your hand is full: {max}/{max}</span> : <span>{per > 1 ? `${progress.since}/${per} ${unit} to the next card` : `A card for every ${unit}`}</span>}
          <span>· best five of {max} win</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const PLACE = [
  { text: "text-[#f5c451]", ring: "ring-[#f5c451]", pill: "border-[#f5c451] text-amber-100 bg-amber-400/10" },
  { text: "text-[#cfd6e2]", ring: "ring-[#cfd6e2]", pill: "border-[#cfd6e2] text-slate-100 bg-white/5" },
  { text: "text-[#d39064]", ring: "ring-[#d39064]", pill: "border-[#d39064] text-orange-100 bg-orange-400/10" },
];
const PLAIN = { text: "text-zinc-400", ring: "ring-white/15", pill: "border-white/15 text-zinc-300 bg-white/5" };
const AVATAR = ["from-violet-500 to-fuchsia-500", "from-sky-500 to-indigo-500", "from-amber-400 to-rose-500", "from-emerald-400 to-teal-600", "from-pink-500 to-orange-400", "from-cyan-400 to-violet-500"];

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
function hue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length]!;
}

function Avatar({ userId, name, ring }: { userId: string; name: string; ring: string }) {
  return (
    <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white ring-2 ring-offset-2 ring-offset-[#12142a] @sm:h-10 @sm:w-10 @sm:text-sm ${hue(userId)} ${ring}`}>
      {initials(name)}
    </span>
  );
}

function Stat({ big, small, className = "" }: { big: string; small: string; className?: string }) {
  return (
    <span className={`shrink-0 text-center leading-none ${className}`}>
      <span className="block text-base font-extrabold tabular-nums text-white @sm:text-xl">{big}</span>
      <span className="mt-0.5 block text-[10px] text-zinc-400 @sm:text-xs">{small}</span>
    </span>
  );
}

/** Under the run card: THE TABLE (hands, ranked) and LEADERBOARD (contacts in the run). */
export function PokerTable({ run, meId, max, pastRuns = [] }: { run: RunSummary; meId: string; max?: number; pastRuns?: RunSummary[] }) {
  const [tab, setTab] = useState<"table" | "board">("table");
  const handMax = run.handMax || 7;
  const rows = max ? run.rows.slice(0, max) : run.rows;
  const byContacts = [...run.rows].sort((a, b) => b.contacts - a.contacts || b.cards.length - a.cards.length);
  const topContacts = Math.max(1, ...run.rows.map((r) => r.contacts));
  const tabCls = (on: boolean) => `relative flex-1 pb-2.5 pt-1 text-center text-xs font-bold uppercase tracking-[0.12em] transition-colors @sm:text-sm ${on ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`;
  return (
    <div className="@container mt-4">
      <div role="tablist" className="flex border-b border-white/10">
        <button type="button" role="tab" aria-selected={tab === "table"} onClick={() => setTab("table")} className={tabCls(tab === "table")}>
          The table
          {tab === "table" ? <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-gradient-to-r from-violet-500 to-violet-400 shadow-[0_0_10px_rgba(139,92,246,0.8)]" /> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "board"} onClick={() => setTab("board")} className={tabCls(tab === "board")}>
          Leaderboard
          {tab === "board" ? <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-gradient-to-r from-violet-500 to-violet-400 shadow-[0_0_10px_rgba(139,92,246,0.8)]" /> : null}
        </button>
      </div>

      {tab === "table" ? (
        run.rows.length === 0 ? (
          <div className="py-4 text-sm text-zinc-500">Nobody has a card yet. The first qualifying outcome deals one.</div>
        ) : (
          <ol className="mt-3 space-y-1.5">
            {rows.map((r) => {
              const look = PLACE[r.place - 1] ?? PLAIN;
              const lead = r.place === 1;
              const mine = r.userId === meId;
              const inner = (
                <div className={`flex items-center gap-2 px-2 py-2 @sm:gap-3 @sm:px-3 @sm:py-2.5 ${lead ? "rounded-[11px] bg-[linear-gradient(90deg,#2a1f4d,#2b2236_55%,#3a2a16)]" : ""}`}>
                  <span className={`w-7 shrink-0 text-sm font-extrabold @sm:w-10 @sm:text-xl ${look.text}`}>{ordinal(r.place)}</span>
                  <Avatar userId={r.userId} name={r.name} ring={look.ring} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-white @sm:text-base">
                      {r.name}
                      {mine ? <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-violet-300">you</span> : null}
                    </span>
                    <span className={`mt-0.5 inline-block max-w-full truncate rounded-full border px-2 py-px text-[10px] font-semibold @sm:text-xs ${r.hand ? look.pill : PLAIN.pill}`} title={r.hand?.label}>
                      {r.hand?.short ?? "No cards yet"}
                    </span>
                  </span>
                  <Stat big={`${r.cards.length}/${handMax}`} small="cards" className="w-9 @sm:w-14" />
                  <Stat big={r.contacts.toLocaleString()} small="Contacts" className="w-12 @sm:w-16" />
                </div>
              );
              return (
                <li key={r.userId} className={lead ? "rounded-xl bg-gradient-to-r from-violet-500 to-amber-400 p-px shadow-[0_0_16px_-6px_rgba(251,191,36,0.6)]" : `border-b border-white/[0.06] ${mine ? "rounded-lg bg-violet-500/[0.07]" : ""}`}>
                  {inner}
                </li>
              );
            })}
            {max && run.rows.length > max ? <li className="px-2 pt-1 text-[11px] text-zinc-500">and {run.rows.length - max} more</li> : null}
          </ol>
        )
      ) : (
        <div className="mt-3">
          <ol className="space-y-2">
            {byContacts.map((r, i) => (
              <li key={r.userId} className="flex items-center gap-2 @sm:gap-3">
                <span className={`w-7 shrink-0 text-sm font-bold @sm:w-9 ${(PLACE[i] ?? PLAIN).text}`}>{ordinal(i + 1)}</span>
                <Avatar userId={r.userId} name={r.name} ring={(PLACE[i] ?? PLAIN).ring} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-semibold text-white">
                      {r.name}
                      {r.userId === meId ? <span className="ml-1 text-[10px] font-medium uppercase text-violet-300">you</span> : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-300">
                      <b className="text-white">{r.contacts.toLocaleString()}</b> contacts · {r.cards.length}/{handMax}
                    </span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-white/10">
                    <span className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-amber-400" style={{ width: `${Math.round((r.contacts / topContacts) * 100)}%` }} />
                  </span>
                </span>
              </li>
            ))}
            {byContacts.length === 0 ? <li className="text-sm text-zinc-500">No contacts in this run yet.</li> : null}
          </ol>
          {pastRuns.length ? (
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">Past winners</div>
              <ul className="space-y-1.5">
                {pastRuns.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-zinc-200">{p.name}</span>
                      <span className="block truncate text-zinc-400">{p.winner ? `${p.winner.userId === meId ? "You" : p.winner.name} · ${p.winner.hand}` : "Nobody held a card"}</span>
                    </span>
                    {p.winner ? (
                      <span className="flex shrink-0 gap-0.5">
                        {p.winner.cards.map((c) => (
                          <PlayingCard key={c} card={c} size="sm" />
                        ))}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
