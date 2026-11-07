"use client";

// The bet board as the owner drew it (7 Nov mockup): a dark Games panel with a
// glowing red-orange BET BOARD header, the agent's live bets as rows with two
// avatars and a red clock, open challenges in green-glow cards with "Take It",
// and a game-like CHALLENGE card (neon frame, gold notches, a gold-coin stake
// slider, a glossy red PUT IT UP button). A win throws a burst of coins.
//
// Rules stay in @strowger/shared/games (betClock, initials, stakeRange,
// settlementLine); styles that need pseudo-elements or keyframes are the
// `sw-bet-*` / `sw-coin-*` classes in globals.css, all off under
// prefers-reduced-motion. Sized for the console's right column (320–360px).
import { WAGER_NOTE_MAX, betClock, initials, stakeRange } from "@strowger/shared/games";
import { useEffect, useId, useState } from "react";
import type { GamesOverview, WagerRow } from "@/lib/games-actions";
import type { Games } from "./games";

type Campaign = NonNullable<GamesOverview["campaign"]>;

const DOTS = "bg-[radial-gradient(rgba(255,255,255,0.06)_1px,transparent_1.2px)] [background-size:11px_11px]";

/** The dark Games panel: blue title, "open ▾" (link to /games, then collapse). */
export function GamesShell({ link, defaultOpen = true, children }: { link: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0a0c18] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_30px_-12px_rgba(0,0,0,0.9)]">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-bold tracking-wide text-sky-400 [text-shadow:0_0_12px_rgba(56,189,248,0.35)]">Games</h2>
        <div className="flex items-center text-xs text-sky-300">
          <a href={link} target="_blank" rel="noreferrer" className="rounded px-1 hover:text-sky-200 hover:underline">
            open
          </a>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? "Collapse" : "Expand"} className="rounded px-1 hover:bg-white/10">
            {open ? "▾" : "▸"}
          </button>
        </div>
      </header>
      {open ? children : null}
    </section>
  );
}

/** A shiny gold coin. */
export function Coin({ size = 14, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={`shrink-0 ${className}`} aria-hidden>
      <defs>
        <radialGradient id={`c${id}`} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#fff7cc" />
          <stop offset="0.3" stopColor="#ffd84a" />
          <stop offset="0.7" stopColor="#e2a313" />
          <stop offset="1" stopColor="#9c6405" />
        </radialGradient>
      </defs>
      <circle cx="10" cy="10" r="9.2" fill={`url(#c${id})`} stroke="#7a4d02" strokeWidth="0.9" />
      <circle cx="10" cy="10" r="6.4" fill="none" stroke="#fff0a8" strokeOpacity="0.65" strokeWidth="0.9" />
      <text x="10" y="13.4" textAnchor="middle" fontSize="9" fontWeight="900" fill="#8a5a00" fontFamily="Arial, sans-serif">
        S
      </text>
    </svg>
  );
}

const AVATAR_HUES = ["from-sky-400 to-indigo-600", "from-fuchsia-400 to-violet-700", "from-amber-300 to-orange-600", "from-emerald-300 to-teal-700", "from-rose-400 to-red-700", "from-cyan-300 to-blue-700"];
function hue(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length]!;
}
function Avatar({ name, id, className = "" }: { name: string; id: string; className?: string }) {
  return (
    <span title={name} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[10px] font-black text-white ring-2 ring-[#0a0c18] [text-shadow:0_1px_1px_rgba(0,0,0,0.5)] ${hue(id)} ${className}`}>
      {initials(name)}
    </span>
  );
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-1.5 mt-4 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
      <span>{title}</span>
      {count !== undefined ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-white/10 px-1 text-[10px] tabular-nums text-zinc-300">{count}</span> : null}
    </div>
  );
}

const name = (w: WagerRow, side: "p" | "a", meId: string) => (side === "p" ? (w.proposerId === meId ? "You" : w.proposer) : w.accepterId ? (w.accepterId === meId ? "You" : w.accepter) : "anyone");
const smallBtn = "sw-bet-press rounded-md px-2 py-0.5 text-[11px] font-bold disabled:opacity-40";

/** The bet clocks tick every second; only the rows re-render, not the whole Games panel. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** A live (or still-open) bet of mine: avatars, who vs who, the question, the clock and the stake. */
function MyBet({ w, meId, children }: { w: WagerRow; meId: string; children?: React.ReactNode }) {
  const meFirst = w.proposerId === meId;
  const other = meFirst ? { n: w.accepterId ? w.accepter : "Anyone", id: w.accepterId ?? "anyone" } : { n: w.proposer, id: w.proposerId };
  const live = w.status === "ACCEPTED";
  const now = useTick(live);
  const clock = live ? betClock(w, new Date(now)) : null;
  return (
    <li className="sw-bet-row rounded-xl border border-white/[0.07] bg-white/[0.03] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 -space-x-2.5">
          <Avatar name="You" id={meId} />
          <Avatar name={other.n} id={other.id} />
        </span>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-zinc-300">
          <b className="text-white">You</b> vs. <b className="text-white">{meFirst ? (w.accepterId ? w.accepter : "anyone") : w.proposer}</b> <span className="text-zinc-500">({w.label}?)</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {clock ? (
            <span title={clock.label} aria-label={clock.label} className="font-mono text-[13px] font-bold tabular-nums text-[#ff4d4d] [text-shadow:0_0_8px_rgba(255,77,77,0.55)]">
              {clock.mode === "riding" ? <span className="sw-bet-blink mr-1 inline-block h-1.5 w-1.5 -translate-y-[2px] rounded-full bg-[#ff4d4d]" aria-hidden /> : null}
              {clock.text}
            </span>
          ) : (
            <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">waiting</span>
          )}
          <span className="flex items-center gap-1 text-[11px] font-bold tabular-nums text-amber-300">
            <Coin size={12} />
            {w.stake.toLocaleString()} pts
          </span>
        </span>
      </div>
      {w.note ? <div className="mt-1 truncate pl-[46px] text-[11px] italic text-zinc-500">&ldquo;{w.note}&rdquo;</div> : null}
      {children ? <div className="mt-1.5 flex justify-end gap-1.5">{children}</div> : null}
    </li>
  );
}

/** An offer on the table: green glow, "Brian vs anyone • Next contact wins", Take It. */
function OpenCard({ w, meId, tone, children }: { w: WagerRow; meId: string; tone: "green" | "violet"; children: React.ReactNode }) {
  const frame = tone === "green" ? "sw-bet-glow-green border-emerald-400/70" : "sw-bet-glow-violet border-fuchsia-400/70";
  return (
    <li className={`rounded-xl border bg-[#07120f]/60 px-2.5 py-2 ${frame}`}>
      <div className="flex items-center gap-2">
        <Avatar name={w.proposer} id={w.proposerId} />
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-zinc-300">
          <b className="text-white">{name(w, "p", meId)}</b> vs <b className="text-white">{w.accepterId === meId ? "you" : name(w, "a", meId)}</b> <span className="text-zinc-500">•</span> {w.short} wins
          <span className="ml-1 inline-flex items-center gap-0.5 align-[-2px] font-bold tabular-nums text-amber-300">
            <Coin size={11} />
            {w.stake.toLocaleString()}
          </span>
          {w.note ? <span className="block truncate text-[11px] italic text-zinc-500">&ldquo;{w.note}&rdquo;</span> : null}
        </span>
        <span className="flex shrink-0 flex-col gap-1">{children}</span>
      </div>
    </li>
  );
}

/** Coins fly up out of the header when a bet is won (static "+N" under reduced motion). */
function WinBurst({ amount }: { amount: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="sw-coin-burst absolute top-2" style={{ "--dx": `${Math.round(Math.cos((i / 12) * Math.PI * 2) * 70)}px`, "--dy": `${Math.round(-30 - Math.abs(Math.sin((i / 12) * Math.PI * 2)) * 50)}px`, animationDelay: `${(i % 4) * 40}ms` } as React.CSSProperties}>
          <Coin size={14} />
        </span>
      ))}
      <span className="sw-win-pop absolute top-1 rounded-full border border-amber-300/70 bg-[#2a1d02]/90 px-3 py-0.5 text-sm font-black tabular-nums text-amber-200 shadow-[0_0_18px_rgba(251,191,36,0.6)]">+{amount.toLocaleString()} pts</span>
    </div>
  );
}

export function BetBoard({ g, o, meId, campaign }: { g: Games; o: GamesOverview; meId: string; campaign: Campaign }) {
  const open = o.wagers.filter((w) => w.status === "OPEN");
  const toMe = open.filter((w) => w.accepterId === meId && w.proposerId !== meId);
  const mineOpen = open.filter((w) => w.proposerId === meId);
  const anyone = open.filter((w) => !w.accepterId && w.proposerId !== meId);
  const live = o.wagers.filter((w) => w.status === "ACCEPTED" && (w.proposerId === meId || w.accepterId === meId));
  const settled = o.settled.slice(0, 4);
  return (
    <section className="relative">
      {g.win ? <WinBurst key={g.win.id} amount={g.win.amount} /> : null}
      <div className="flex items-baseline justify-between gap-2">
        <div className="sw-bet-title text-[15px] font-black uppercase tracking-[0.12em] text-[#ff5a2c]">Bet board</div>
        <div className="truncate text-[11px] text-zinc-500">
          {campaign.weeklyPoints.toLocaleString()} every Monday • max {campaign.maxStake.toLocaleString()}
        </div>
      </div>
      {g.err ? <div className="mt-2 rounded-lg border border-red-900 bg-red-950/50 px-2 py-1 text-xs text-red-200">{g.err}</div> : null}

      {toMe.length ? (
        <>
          <SectionTitle title="Challenges to you" count={toMe.length} />
          <ul className="space-y-1.5">
            {toMe.map((w) => (
              <OpenCard key={w.id} w={w} meId={meId} tone="violet">
                <button type="button" disabled={g.busy || o.points < w.stake} title={o.points < w.stake ? "Not enough points" : undefined} onClick={() => void g.act({ action: "accept", wagerId: w.id })} className={`${smallBtn} border border-emerald-400 text-emerald-300 hover:bg-emerald-400/15`}>
                  Accept
                </button>
                <button type="button" disabled={g.busy} onClick={() => void g.act({ action: "decline", wagerId: w.id })} className={`${smallBtn} border border-white/15 text-zinc-300 hover:bg-white/10`}>
                  Decline
                </button>
              </OpenCard>
            ))}
          </ul>
        </>
      ) : null}

      <SectionTitle title="Your bets" />
      <ul className="space-y-1.5">
        {live.map((w) => (
          <MyBet key={w.id} w={w} meId={meId} />
        ))}
        {mineOpen.map((w) => (
          <MyBet key={w.id} w={w} meId={meId}>
            <button type="button" disabled={g.busy} onClick={() => void g.act({ action: "withdraw", wagerId: w.id })} className={`${smallBtn} border border-white/15 text-zinc-300 hover:bg-white/10`}>
              Withdraw
            </button>
          </MyBet>
        ))}
        {live.length + mineOpen.length === 0 ? <li className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-xs text-zinc-500">Nothing riding. Put one up below.</li> : null}
      </ul>

      <SectionTitle title="Open to anyone" count={anyone.length} />
      <ul className="space-y-1.5">
        {anyone.map((w) => (
          <OpenCard key={w.id} w={w} meId={meId} tone="green">
            <button type="button" disabled={g.busy || o.points < w.stake} title={o.points < w.stake ? "Not enough points" : undefined} onClick={() => void g.act({ action: "accept", wagerId: w.id })} className={`${smallBtn} border-[1.5px] border-emerald-400 px-3 py-1 text-[12px] text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.35)] hover:bg-emerald-400/15`}>
              Take It
            </button>
          </OpenCard>
        ))}
        {anyone.length === 0 ? <li className="rounded-xl border border-dashed border-white/10 px-3 py-2 text-xs text-zinc-500">Nothing on the table.</li> : null}
      </ul>

      {settled.length ? (
        <>
          <SectionTitle title="Recently settled" />
          <ul className="space-y-0.5 text-[11px] text-zinc-500">
            {settled.map((w) => {
              const winner = w.winnerId ? (w.winnerId === meId ? "You" : w.winnerId === w.proposerId ? w.proposer : w.accepter) : null;
              return (
                <li key={w.id} className="truncate">
                  {w.short}: {name(w, "p", meId)} vs {name(w, "a", meId)} ·{" "}
                  {winner ? <b className={w.winnerId === meId ? "text-emerald-300" : "text-zinc-300"}>{winner} won {(w.stake * 2).toLocaleString()}</b> : "push"}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <ChallengeCard g={g} o={o} meId={meId} campaign={campaign} />
    </section>
  );
}

function ChallengeCard({ g, o, meId, campaign }: { g: Games; o: GamesOverview; meId: string; campaign: Campaign }) {
  const [against, setAgainst] = useState("");
  const [kind, setKind] = useState(() => (o.kinds.some((k) => k.kind === "NEXT_CONTACT") ? "NEXT_CONTACT" : (o.kinds[0]?.kind ?? "NEXT_SALE")));
  const [stake, setStake] = useState(500);
  const [note, setNote] = useState("");
  const range = stakeRange(o.points, campaign.maxStake);
  const value = Math.max(Math.min(stake, range.max), range.min);
  const pct = range.max > range.min ? ((value - range.min) / (range.max - range.min)) * 100 : 0;
  const others = o.players.filter((p) => p.id !== meId);
  const instant = o.kinds.find((k) => k.kind === kind)?.instant ?? true;
  const empty = range.max === 0;
  const submit = async () => {
    const ok = await g.act({ action: "propose", campaignId: campaign.id, kind, stake: value, accepterId: against || null, note: note.trim() || undefined });
    if (ok) setNote("");
  };
  const field = "sw-bet-field w-full appearance-none rounded-lg border bg-[#080a16] py-1.5 pl-2.5 pr-7 text-[12px] text-zinc-100 outline-none";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="relative mt-5 rounded-2xl bg-gradient-to-br from-fuchsia-500 via-violet-500 to-sky-500 p-[1.5px] shadow-[0_0_22px_-6px_rgba(139,92,246,0.85)]"
    >
      <span className="absolute left-1/2 top-0 z-10 h-[5px] w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-b from-amber-200 to-amber-500 shadow-[0_0_8px_rgba(251,191,36,0.8)]" aria-hidden />
      <span className="absolute bottom-0 left-1/2 z-10 h-[5px] w-10 -translate-x-1/2 translate-y-1/2 rounded-full bg-gradient-to-b from-amber-200 to-amber-500 shadow-[0_0_8px_rgba(251,191,36,0.8)]" aria-hidden />
      <div className={`rounded-t-[15px] bg-[#0d0f24] px-3 pb-3 pt-3.5 ${DOTS}`}>
        <div className="mb-3 bg-gradient-to-r from-fuchsia-400 via-violet-400 to-indigo-300 bg-clip-text text-center text-[15px] font-black uppercase tracking-[0.3em] text-transparent">Challenge</div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-zinc-400">Who</span>
          <span className="relative block">
            <select value={against} onChange={(e) => setAgainst(e.target.value)} className={`${field} border-violet-500/80 shadow-[0_0_10px_-2px_rgba(167,139,250,0.7)] focus:border-violet-300`}>
              <option value="">Anyone who takes it</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-violet-300" aria-hidden>
              ▼
            </span>
          </span>
        </label>

        <label className="mt-2.5 block">
          <span className="mb-1 block text-[11px] font-semibold text-zinc-400">On</span>
          <span className="relative block">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${field} border-sky-500/80 shadow-[0_0_10px_-2px_rgba(56,189,248,0.7)] focus:border-sky-300`}>
              {o.kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-sky-300" aria-hidden>
              ▼
            </span>
          </span>
        </label>

        <label className="mt-3 block">
          <span className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-zinc-400">Stake</span>
            <span className="text-[15px] font-black tabular-nums text-amber-300 [text-shadow:0_0_10px_rgba(251,191,36,0.5)]">{value.toLocaleString()} pts</span>
          </span>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={range.step}
            value={value}
            disabled={empty}
            onChange={(e) => setStake(Number(e.target.value))}
            aria-label="Stake in points"
            aria-valuetext={`${value.toLocaleString()} points`}
            className="sw-coin-range mt-1.5 w-full"
            style={{ "--pct": `${pct}%` } as React.CSSProperties}
          />
          <span className="mt-0.5 flex justify-between text-[10px] tabular-nums text-zinc-500">
            <span>{range.min}</span>
            <span>{range.max === Math.floor(o.points) ? `your purse, ${o.points.toLocaleString()}` : `max ${range.max.toLocaleString()}`}</span>
          </span>
        </label>

        <label className="mt-2.5 block">
          <span className="mb-1 flex justify-between text-[11px]">
            <span className="font-semibold text-zinc-400">Trash talk (optional)</span>
            <span className={`tabular-nums ${note.length >= WAGER_NOTE_MAX ? "text-amber-300" : "text-zinc-500"}`}>
              {note.length}/{WAGER_NOTE_MAX}
            </span>
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, WAGER_NOTE_MAX))}
            maxLength={WAGER_NOTE_MAX}
            placeholder="Bring your A game 🔥"
            className="sw-bet-field w-full rounded-lg border border-sky-400/80 bg-[#080a16] px-2.5 py-1.5 text-[12px] text-zinc-100 shadow-[0_0_12px_-2px_rgba(56,189,248,0.75)] outline-none placeholder:text-zinc-600 focus:border-sky-300"
          />
        </label>

        <div className="mt-3.5 flex items-center gap-3">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-500">{instant ? "Settles the moment it happens to either of you." : "Settles when the period ends; a tie returns both stakes."}</span>
          <span className="shrink-0 rounded-[14px] bg-gradient-to-b from-zinc-100 via-zinc-500 to-zinc-300 p-[2px] shadow-[0_6px_14px_-4px_rgba(220,38,38,0.6)]">
            <button type="submit" disabled={g.busy || empty} className="sw-bet-cta block rounded-xl border border-[#5c0905] bg-[linear-gradient(180deg,#ff7a66_0%,#ef3b26_38%,#c41a10_70%,#8f0f08_100%)] px-4 py-2 text-[13px] font-black uppercase tracking-wider text-white [text-shadow:0_1px_0_rgba(0,0,0,0.45)] disabled:cursor-not-allowed disabled:opacity-50">
              Put it up
            </button>
          </span>
        </div>
        {empty ? <div className="mt-1.5 text-[11px] text-zinc-500">Your purse is empty until the Monday top-up.</div> : null}
      </div>
      <div className="rounded-b-[15px] border-t border-white/[0.06] bg-[#0d0f24] px-3 pb-2.5 pt-2 text-center text-[10px] text-zinc-500">
        Your purse refreshes every Monday • Max wager {campaign.maxStake.toLocaleString()} pts{" "}
        <span tabIndex={0} title={`Each Monday your purse is set to ${campaign.weeklyPoints.toLocaleString()} pts. One bet risks at most ${campaign.maxStake.toLocaleString()} pts, or what's in your purse if that's less. The winner takes both stakes.`} className="cursor-help text-zinc-400 outline-none focus-visible:text-sky-300">
          ⓘ
        </span>
      </div>
    </form>
  );
}
