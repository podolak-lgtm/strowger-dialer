"use client";

// Games on the agent console (owner, 5 Nov: "The agent should actually see
// their cards. It should be graphical. It should be fun ... The same with the
// points. Agents should be able to make bets with each other.").
//
//   useGames      one overview per console, reloaded on every games:* event;
//                 the deal queue (games:card) and the bet toasts (games:wager)
//   PointsPurse   chip counter in the top bar, animates, history popover
//   GamesLayer    the deal moment and the toasts; fixed bottom-right on wide
//                 screens (over chat, never the call column), in the page flow
//                 on narrow ones so it covers nothing
//   GamesPanel    the run (hand, place, leaderboard) and the bet board
//
// Rules (hand names, places, who may decline) are in @strowger/shared/games.
import { PlayingCard, PokerHand, RunLeaderboard } from "@/components/playing-card";
import { gamesOverview, wager, type CardEvent, type GamesOverview, type WagerEvent, type WagerRow } from "@/lib/games-actions";
import { WAGER_NOTE_MAX, placeLine, settlementLine, timeLeft } from "@strowger/shared/games";
import type { Socket } from "socket.io-client";
import { useCallback, useEffect, useRef, useState } from "react";

type Toast = { id: number; tone: "challenge" | "won" | "lost" | "push" | "info"; text: string; note?: string | null; wagerId?: string };
type Deal = { id: number; card: string; run: string; hand: string | null };
type WagerInput = Parameters<typeof wager>[0];

export type Games = ReturnType<typeof useGames>;

const GAME_EVENTS = ["games:run", "games:bets", "games:wager", "games:card", "games:points", "games:poker"];

/** One overview for the console; the deal queue plays only off a call (`onCall` holds it). */
export function useGames({ campaignId, socket, meId, enabled, onCall }: { campaignId: string; socket: Socket | null; meId: string; enabled: boolean; onCall: boolean }) {
  const [o, setO] = useState<GamesOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!enabled || !campaignId) return;
    void gamesOverview(campaignId).then(setO).catch(() => undefined);
  }, [campaignId, enabled]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const pushToast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      if (t.tone !== "challenge") setTimeout(() => dismissToast(id), 7000);
    },
    [dismissToast],
  );

  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(reload, 0);
    const t = setInterval(reload, 30_000);
    for (const e of GAME_EVENTS) socket?.on(e, reload);
    const onCard = (c: CardEvent) => setDeals((d) => [...d, { id: ++seq.current, card: c.card, run: c.run, hand: c.hand }]);
    const onWager = (w: WagerEvent) => {
      if (w.status !== "OPEN") setToasts((list) => list.filter((x) => x.wagerId !== w.id || x.tone !== "challenge"));
      if (w.status === "OPEN" && w.accepterId === meId && w.proposerId !== meId) {
        pushToast({ tone: "challenge", wagerId: w.id, text: `${w.proposer} challenges you: ${w.stake.toLocaleString()} pts on ${w.short}`, note: w.note });
      } else if (w.status === "ACCEPTED" && w.proposerId === meId) {
        pushToast({ tone: "info", text: `${w.accepter} took your ${w.stake.toLocaleString()} pts on ${w.short}. Game on.` });
      } else if (w.status === "DECLINED" && w.declined && w.proposerId === meId) {
        pushToast({ tone: "info", text: `${w.accepter} declined your ${w.stake.toLocaleString()} pts on ${w.short}; it's back in your purse.` });
      } else if (w.status === "SETTLED") {
        const line = settlementLine(w, meId);
        if (line) pushToast({ tone: line.tone, text: line.text });
      }
    };
    socket?.on("games:card", onCard);
    socket?.on("games:wager", onWager);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      for (const e of GAME_EVENTS) socket?.off(e, reload);
      socket?.off("games:card", onCard);
      socket?.off("games:wager", onWager);
    };
  }, [enabled, reload, socket, meId, pushToast]);

  // The deal moment: one card at a time, held while the agent is on a call.
  const deal = onCall ? null : (deals[0] ?? null);
  const dealId = deal?.id ?? null;
  const dismissDeal = useCallback(() => setDeals((d) => d.slice(1)), []);
  useEffect(() => {
    if (dealId === null) return;
    const t = setTimeout(dismissDeal, 2300);
    return () => clearTimeout(t);
  }, [dealId, dismissDeal]);

  const act = useCallback(
    async (input: WagerInput): Promise<boolean> => {
      setBusy(true);
      const r = await wager(input);
      setErr(r.ok ? null : r.error);
      setBusy(false);
      reload();
      return r.ok;
    },
    [reload],
  );

  return { o, busy, err, act, reload, toasts, dismissToast, deal, dismissDeal };
}

/** Wall clock for "2 days 5 hours left". */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Counts from the last value to the new one (no animation under reduced motion); the flash is the movement. */
function useCountTo(target: number): { shown: number; flash: { id: number; delta: number } | null } {
  const [shown, setShown] = useState(target);
  const [flash, setFlash] = useState<{ id: number; delta: number } | null>(null);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dur = reduce ? 0 : 900;
    let raf = 0;
    let t0: number | null = null;
    const step = (t: number) => {
      if (t0 === null) {
        t0 = t;
        setFlash({ id: t, delta: target - start });
      }
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      setShown(Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return { shown, flash };
}

const KIND_LOOK: Record<GamesOverview["ledger"][number]["kind"], { label: string; glyph: string; cls: string }> = {
  topup: { label: "Top-up", glyph: "▲", cls: "text-sky-300" },
  won: { label: "Bet won", glyph: "★", cls: "text-emerald-300" },
  lost: { label: "Bet lost", glyph: "✕", cls: "text-red-300" },
  refund: { label: "Refund", glyph: "↺", cls: "text-zinc-300" },
  stake: { label: "Stake", glyph: "●", cls: "text-fuchsia-300" },
  other: { label: "Points", glyph: "·", cls: "text-zinc-400" },
};

/** "12,500 pts" in the top bar: a poker chip that counts up or down, with the last 10 movements. */
export function PointsPurse({ g }: { g: Games }) {
  const points = g.o?.points ?? 0;
  const { shown, flash } = useCountTo(points);
  const [open, setOpen] = useState(false);
  if (!g.o) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        aria-expanded={open}
        aria-label={`Points purse: ${points.toLocaleString()} points. Show history`}
        className="flex items-center gap-1.5 rounded-full border-2 border-black bg-[#1b1b1f] py-0.5 pl-0.5 pr-2.5 shadow-[2px_2px_0_#000] hover:bg-zinc-800"
      >
        <span key={flash?.id ?? 0} className="sw-pop grid h-6 w-6 place-items-center rounded-full border-2 border-dashed border-[#f6efe0] bg-[#c8472b] text-[9px] font-black text-[#f6efe0]">
          S
        </span>
        <span className="text-sm font-black tabular-nums text-[#f6efe0]">{shown.toLocaleString()} pts</span>
      </button>
      {flash && flash.delta !== 0 ? (
        <span key={flash.id} aria-hidden className={`sw-float-up pointer-events-none absolute -top-3 right-2 text-xs font-black tabular-nums opacity-0 ${flash.delta > 0 ? "text-emerald-300" : "text-red-300"}`}>
          {flash.delta > 0 ? "+" : ""}
          {flash.delta.toLocaleString()}
        </span>
      ) : null}
      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-lg border-2 border-black bg-zinc-900 p-3 shadow-[4px_4px_0_#000]">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-bold uppercase tracking-wide text-zinc-300">Points history</span>
            <button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-200" aria-label="Close history">
              ✕
            </button>
          </div>
          <ul className="space-y-1 text-xs">
            {g.o.ledger.slice(0, 10).map((l) => {
              const look = KIND_LOOK[l.kind];
              return (
                <li key={l.id} className="flex items-center gap-2 rounded bg-white/5 px-2 py-1">
                  <span className={`w-3 text-center ${look.cls}`} aria-hidden>
                    {look.glyph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`font-semibold ${look.cls}`}>{look.label}</span>
                    <span className="block truncate text-[11px] text-zinc-500" title={l.reason}>
                      {l.reason} · {new Date(l.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </span>
                  <span className={`tabular-nums ${l.delta > 0 ? "text-emerald-300" : l.delta < 0 ? "text-red-300" : "text-zinc-500"}`}>
                    {l.delta > 0 ? "+" : ""}
                    {l.delta === 0 ? "—" : l.delta.toLocaleString()}
                  </span>
                </li>
              );
            })}
            {g.o.ledger.length === 0 ? <li className="text-zinc-500">No movements yet.</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const TOAST_TONE: Record<Toast["tone"], string> = {
  challenge: "border-fuchsia-400 bg-fuchsia-950/95",
  won: "border-emerald-400 bg-emerald-950/95",
  lost: "border-red-400 bg-red-950/95",
  push: "border-zinc-400 bg-zinc-900/95",
  info: "border-sky-400 bg-zinc-900/95",
};

/** The deal moment and the bet toasts. Wide screens: fixed bottom-right, over the chat column and
 *  clear of the call controls and dispositions. Narrow screens: in the page flow, covering nothing. */
export function GamesLayer({ g }: { g: Games }) {
  if (!g.deal && g.toasts.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col items-stretch gap-2 xl:fixed xl:bottom-4 xl:right-4 xl:z-40 xl:mb-0 xl:w-[280px]" aria-live="polite">
      {g.deal ? <DealMoment key={g.deal.id} deal={g.deal} onDismiss={g.dismissDeal} /> : null}
      {g.toasts.map((t) => (
        <div key={t.id} role={t.tone === "challenge" ? "alertdialog" : "status"} aria-label={t.text} className={`sw-toast-in rounded-lg border-2 px-3 py-2 text-sm text-zinc-100 shadow-[3px_3px_0_#000] ${TOAST_TONE[t.tone]}`}>
          <div className="flex items-start gap-2">
            <span className="flex-1 font-semibold">{t.text}</span>
            <button type="button" onClick={() => g.dismissToast(t.id)} aria-label="Dismiss" className="text-zinc-400 hover:text-white">
              ✕
            </button>
          </div>
          {t.note ? <div className="mt-0.5 text-xs italic text-fuchsia-200">&ldquo;{t.note}&rdquo;</div> : null}
          {t.tone === "challenge" && t.wagerId ? (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={g.busy}
                onClick={() => void g.act({ action: "accept", wagerId: t.wagerId }).then((ok) => ok && g.dismissToast(t.id))}
                className="rounded border-2 border-black bg-emerald-400 px-3 py-0.5 text-xs font-black text-emerald-950 shadow-[2px_2px_0_#000] disabled:opacity-40"
              >
                Accept
              </button>
              <button
                type="button"
                disabled={g.busy}
                onClick={() => void g.act({ action: "decline", wagerId: t.wagerId }).then((ok) => ok && g.dismissToast(t.id))}
                className="rounded border-2 border-black bg-zinc-200 px-3 py-0.5 text-xs font-black text-zinc-900 shadow-[2px_2px_0_#000] disabled:opacity-40"
              >
                Decline
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A card flips from its back to its face and slides away toward the hand; about two seconds. */
function DealMoment({ deal, onDismiss }: { deal: Deal; onDismiss: () => void }) {
  return (
    <div role="status" className="sw-deal-away sw-halftone-red relative flex items-center gap-3 rounded-xl border-2 border-black bg-[#f6efe0] p-3 text-[#1b1b1f] shadow-[4px_4px_0_#000]">
      <div className="[perspective:600px]">
        {/* Two-sided: the back faces the agent first, the face turns over (none of it under reduced motion). */}
        <div className="sw-deal-flip relative" style={{ transformStyle: "preserve-3d" }}>
          <div style={{ backfaceVisibility: "hidden" }}>
            <PlayingCard card={deal.card} size="md" />
          </div>
          <div className="absolute inset-0" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }} aria-hidden>
            <PlayingCard card={null} size="md" />
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-2xl font-black leading-none text-[#c8472b]">+1 card</div>
        <div className="mt-1 truncate text-xs font-bold uppercase tracking-wide">{deal.run}</div>
        {deal.hand ? <div className="truncate text-xs">{deal.hand}</div> : null}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="absolute right-1.5 top-1 text-xs font-bold text-[#1b1b1f]/60 hover:text-[#1b1b1f]">
        ✕
      </button>
    </div>
  );
}

function ruleLine(run: NonNullable<GamesOverview["run"]>): string {
  if (run.qualifies === "CODES") return `A card for every ${run.codes.join(", ")}`;
  return run.qualifies === "CONTACT" ? "A card for every live contact" : "A card for every sale";
}

/** The Games panel: the poker run (my hand, my place, everyone's hands) and the bet board. */
export function GamesPanel({ g, meId, campaignId, Panel }: { g: Games; meId: string; campaignId: string; Panel: React.ComponentType<{ title: string; right?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode; className?: string }> }) {
  const now = useNow(60_000);
  const o = g.o;
  const link = (
    <a href={`/games?campaign=${encodeURIComponent(campaignId)}`} target="_blank" rel="noreferrer" className="text-xs text-sky-300 underline">
      open
    </a>
  );
  if (!o) return null;
  const c = o.campaign && o.campaign.id === campaignId ? o.campaign : null;
  const betsOn = Boolean(c?.betsEnabled);
  const run = o.run && o.run.campaignId === campaignId ? o.run : null;
  if (!betsOn && !run) {
    return (
      <Panel title="Games" right={link} defaultOpen={false}>
        <div className="text-sm text-zinc-400">Games are off for this campaign: no bets and no poker run. A supervisor switches them on from the campaign page.</div>
      </Panel>
    );
  }
  const mine = run?.rows.find((r) => r.userId === meId) ?? null;
  return (
    <Panel title="Games" right={link} className="border-2 border-black shadow-[3px_3px_0_#000]">
      {run ? (
        <section className="sw-halftone mb-4 rounded-lg border-2 border-black bg-gradient-to-br from-fuchsia-950/60 to-zinc-950 p-3 shadow-[2px_2px_0_#000]">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#e98a72]">Poker run</div>
              <div className="truncate text-base font-black">{run.name}</div>
            </div>
            <div className="shrink-0 text-right text-xs">
              <div className="font-semibold text-zinc-200">{run.live ? timeLeft(run.endsAt, new Date(now)) : "not running"}</div>
              <div className="text-zinc-400">{placeLine(run.rows, meId)}</div>
            </div>
          </div>
          {run.prize ? <div className="mt-1 inline-block rounded border border-black bg-amber-300 px-1.5 text-xs font-bold text-black">Prize: {run.prize}</div> : null}
          <div className="mt-2">
            <PokerHand cards={mine?.cards ?? []} best={mine?.hand?.cards} makers={mine?.hand?.makers} label={mine?.hand?.label ?? null} size="md" />
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">{ruleLine(run)} · best five cards when the run ends win</div>
          <div className="mt-3">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400">The table</div>
            <RunLeaderboard rows={run.rows} meId={meId} max={6} />
          </div>
        </section>
      ) : (
        <div className="mb-3 text-xs text-zinc-500">No poker run on this campaign right now.</div>
      )}
      {betsOn && c ? <BetBoard g={g} o={o} meId={meId} campaign={c} /> : <div className="text-xs text-zinc-500">Bets are off for this campaign.</div>}
    </Panel>
  );
}

function BetLine({ w, meId, children }: { w: WagerRow; meId: string; children?: React.ReactNode }) {
  const vs = w.accepterId ? (w.accepterId === meId ? "you" : w.accepter) : "anyone";
  return (
    <li className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs">
          <b>{w.proposerId === meId ? "You" : w.proposer}</b> <span className="text-zinc-500">vs</span> <b>{vs}</b> · {w.short} ·{" "}
          <span className="font-bold tabular-nums text-fuchsia-300">{w.stake.toLocaleString()}</span>
        </span>
        {children}
      </div>
      {w.note ? <div className="truncate text-[11px] italic text-zinc-400">&ldquo;{w.note}&rdquo;</div> : null}
    </li>
  );
}

const btn = "rounded border-2 border-black px-2 py-0.5 text-[11px] font-black shadow-[1px_1px_0_#000] disabled:opacity-40";

function BetBoard({ g, o, meId, campaign }: { g: Games; o: GamesOverview; meId: string; campaign: NonNullable<GamesOverview["campaign"]> }) {
  const open = o.wagers.filter((w) => w.status === "OPEN");
  const toMe = open.filter((w) => w.accepterId === meId && w.proposerId !== meId);
  const mineOpen = open.filter((w) => w.proposerId === meId);
  const anyone = open.filter((w) => !w.accepterId && w.proposerId !== meId);
  const live = o.wagers.filter((w) => w.status === "ACCEPTED" && (w.proposerId === meId || w.accepterId === meId));
  const settled = o.settled.slice(0, 5);
  const section = (title: string, n: number) => (
    <div className="mb-1 mt-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-zinc-400">
      <span>{title}</span>
      <span className="rounded bg-white/10 px-1.5 tabular-nums">{n}</span>
    </div>
  );
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#e98a72]">Bet board</div>
        <div className="text-[11px] text-zinc-500">
          {campaign.weeklyPoints.toLocaleString()} every Monday · max {campaign.maxStake.toLocaleString()}
        </div>
      </div>
      {g.err ? <div className="my-1 rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-200">{g.err}</div> : null}

      {toMe.length ? (
        <>
          {section("Challenges to you", toMe.length)}
          <ul className="space-y-1">
            {toMe.map((w) => (
              <BetLine key={w.id} w={w} meId={meId}>
                <button type="button" disabled={g.busy} onClick={() => void g.act({ action: "accept", wagerId: w.id })} className={`${btn} bg-emerald-400 text-emerald-950`}>
                  Accept
                </button>
                <button type="button" disabled={g.busy} onClick={() => void g.act({ action: "decline", wagerId: w.id })} className={`${btn} bg-zinc-200 text-zinc-900`}>
                  Decline
                </button>
              </BetLine>
            ))}
          </ul>
        </>
      ) : null}

      {section("Your bets", mineOpen.length + live.length)}
      <ul className="space-y-1">
        {live.map((w) => (
          <BetLine key={w.id} w={w} meId={meId}>
            <span className="rounded bg-sky-500/20 px-1.5 text-[10px] font-bold uppercase text-sky-200">live</span>
          </BetLine>
        ))}
        {mineOpen.map((w) => (
          <BetLine key={w.id} w={w} meId={meId}>
            <button type="button" disabled={g.busy} onClick={() => void g.act({ action: "withdraw", wagerId: w.id })} className={`${btn} bg-zinc-800 text-zinc-200`}>
              Withdraw
            </button>
          </BetLine>
        ))}
        {mineOpen.length + live.length === 0 ? <li className="text-xs text-zinc-500">Nothing riding. Challenge somebody below.</li> : null}
      </ul>

      {section("Open to anyone", anyone.length)}
      <ul className="space-y-1">
        {anyone.map((w) => (
          <BetLine key={w.id} w={w} meId={meId}>
            <button type="button" disabled={g.busy || o.points < w.stake} onClick={() => void g.act({ action: "accept", wagerId: w.id })} className={`${btn} bg-emerald-400 text-emerald-950`} title={o.points < w.stake ? "Not enough points" : undefined}>
              Take it
            </button>
          </BetLine>
        ))}
        {anyone.length === 0 ? <li className="text-xs text-zinc-500">Nothing on the table.</li> : null}
      </ul>

      {settled.length ? (
        <>
          {section("Recently settled", settled.length)}
          <ul className="space-y-0.5 text-[11px] text-zinc-400">
            {settled.map((w) => {
              const winner = w.winnerId ? (w.winnerId === meId ? "You" : w.winnerId === w.proposerId ? w.proposer : w.accepter) : null;
              return (
                <li key={w.id} className="truncate">
                  {w.short}: {w.proposerId === meId ? "you" : w.proposer} vs {w.accepterId === meId ? "you" : w.accepter} ·{" "}
                  {winner ? <b className={w.winnerId === meId ? "text-emerald-300" : "text-zinc-200"}>{winner} won {(w.stake * 2).toLocaleString()}</b> : "push"}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <ChallengeForm g={g} o={o} meId={meId} campaign={campaign} />
    </section>
  );
}

function ChallengeForm({ g, o, meId, campaign }: { g: Games; o: GamesOverview; meId: string; campaign: NonNullable<GamesOverview["campaign"]> }) {
  const [against, setAgainst] = useState("");
  const [kind, setKind] = useState("NEXT_SALE");
  const [stake, setStake] = useState(500);
  const [note, setNote] = useState("");
  const cap = Math.max(0, Math.min(campaign.maxStake, o.points));
  const value = Math.max(Math.min(stake, cap), cap > 0 ? 1 : 0);
  const step = cap >= 1000 ? 50 : cap >= 100 ? 10 : 1;
  const others = o.players.filter((p) => p.id !== meId);
  const submit = async () => {
    const ok = await g.act({ action: "propose", campaignId: campaign.id, kind, stake: value, accepterId: against || null, note: note.trim() || undefined });
    if (ok) setNote("");
  };
  return (
    <form
      className="mt-4 rounded-lg border-2 border-black bg-black/30 p-2.5 shadow-[2px_2px_0_#000]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mb-2 text-xs font-black uppercase tracking-wide text-fuchsia-300">Challenge</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="text-zinc-400">Who</span>
          <select value={against} onChange={(e) => setAgainst(e.target.value)} className="mt-0.5 w-full rounded border border-white/10 bg-zinc-950 px-1.5 py-1">
            <option value="">Anyone who takes it</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-zinc-400">On</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-0.5 w-full rounded border border-white/10 bg-zinc-950 px-1.5 py-1">
            {o.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-2 block text-xs">
        <span className="flex justify-between text-zinc-400">
          <span>Stake</span>
          <span className="font-black tabular-nums text-fuchsia-200">{value.toLocaleString()} pts</span>
        </span>
        <input type="range" min={cap > 0 ? 1 : 0} max={cap} step={step} value={value} disabled={cap === 0} onChange={(e) => setStake(Number(e.target.value))} className="mt-1 w-full accent-fuchsia-500" aria-label="Stake in points" />
        <span className="flex justify-between text-[10px] text-zinc-500">
          <span>1</span>
          <span>{cap === o.points && cap < campaign.maxStake ? `your purse, ${cap.toLocaleString()}` : `cap ${cap.toLocaleString()}`}</span>
        </span>
      </label>
      <label className="mt-2 block text-xs">
        <span className="flex justify-between text-zinc-400">
          <span>Trash talk (optional)</span>
          <span className="tabular-nums text-zinc-500">
            {note.length}/{WAGER_NOTE_MAX}
          </span>
        </span>
        <input value={note} onChange={(e) => setNote(e.target.value.slice(0, WAGER_NOTE_MAX))} maxLength={WAGER_NOTE_MAX} placeholder="Bring your A game" className="mt-0.5 w-full rounded border border-white/10 bg-zinc-950 px-1.5 py-1" />
      </label>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-zinc-500">{o.kinds.find((k) => k.kind === kind)?.instant ? "Settles the moment it happens to either of you." : "Settles when the period ends; a tie returns both stakes."}</span>
        <button type="submit" disabled={g.busy || cap === 0} className="rounded-md border-2 border-black bg-[#c8472b] px-3 py-1 text-xs font-black uppercase text-[#f6efe0] shadow-[2px_2px_0_#000] disabled:opacity-40">
          {against ? "Challenge" : "Put it up"}
        </button>
      </div>
      {cap === 0 ? <div className="mt-1 text-[11px] text-zinc-500">Your purse is empty until the Monday top-up.</div> : null}
    </form>
  );
}

