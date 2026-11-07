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
//                 (bet-board.tsx: the owner's 7 Nov mockup)
//
// Rules (hand names, places, who may decline) are in @strowger/shared/games.
import { PlayingCard } from "@/components/playing-card";
import { PokerRunCard, PokerTable } from "@/components/poker-run";
import { gamesOverview, wager, type CardEvent, type FullEvent, type GamesOverview, type WagerEvent } from "@/lib/games-actions";
import { BetBoard, GamesShell } from "./bet-board";
import { handFullLine, placeLine, settlementLine } from "@strowger/shared/games";
import type { Socket } from "socket.io-client";
import { useCallback, useEffect, useRef, useState } from "react";

type Toast = { id: number; tone: "challenge" | "won" | "lost" | "push" | "info"; text: string; note?: string | null; wagerId?: string };
type Deal = { id: number; card: string; run: string; hand: string | null };
type WagerInput = Parameters<typeof wager>[0];

export type Games = ReturnType<typeof useGames>;

const GAME_EVENTS = ["games:run", "games:bets", "games:wager", "games:card", "games:points", "games:poker", "games:full"];

/** One overview for the console; the deal queue plays only off a call (`onCall` holds it). */
export function useGames({ campaignId, socket, meId, enabled, onCall }: { campaignId: string; socket: Socket | null; meId: string; enabled: boolean; onCall: boolean }) {
  const [o, setO] = useState<GamesOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  /** A bet I just won: the bet board throws coins (keyed by id so a second win replays it). */
  const [win, setWin] = useState<{ id: number; amount: number } | null>(null);
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
        if (line?.tone === "won") {
          const id = ++seq.current;
          setWin({ id, amount: w.stake * 2 });
          setTimeout(() => setWin((x) => (x?.id === id ? null : x)), 2600);
        }
      }
    };
    const onFull = (f: FullEvent) => pushToast({ tone: "info", text: `${handFullLine(f.held) ?? "Your hand is full"} in ${f.run}. Best five of seven win.` });
    socket?.on("games:card", onCard);
    socket?.on("games:wager", onWager);
    socket?.on("games:full", onFull);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      for (const e of GAME_EVENTS) socket?.off(e, reload);
      socket?.off("games:card", onCard);
      socket?.off("games:wager", onWager);
      socket?.off("games:full", onFull);
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

  return { o, busy, err, act, reload, toasts, dismissToast, deal, dismissDeal, win };
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
    <div role="status" className="sw-deal-away rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500/50 to-amber-400 p-[1.5px] shadow-[0_0_24px_-6px_rgba(139,92,246,0.8)]">
      <div className="relative flex items-center gap-3 rounded-[15px] bg-[#12142a] bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1.2px)] p-3 text-white [background-size:12px_12px]">
        <div className="[perspective:600px]">
          {/* Two-sided: the back faces the agent first, the face turns over (none of it under reduced motion). */}
          <div className="sw-deal-flip relative" style={{ transformStyle: "preserve-3d" }}>
            <div style={{ backfaceVisibility: "hidden" }}>
              <PlayingCard card={deal.card} size="lg" className="!w-16" />
            </div>
            <div className="absolute inset-0" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }} aria-hidden>
              <PlayingCard card={null} size="lg" className="!w-16" />
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-black leading-none text-[#ff6a3d]">+1 card</div>
          <div className="mt-1 truncate text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-400">{deal.run}</div>
          {deal.hand ? <div className="truncate text-sm font-bold text-amber-300">{deal.hand}</div> : null}
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="absolute right-2 top-1.5 text-xs font-bold text-zinc-500 hover:text-white">
          ✕
        </button>
      </div>
    </div>
  );
}

/** The Games panel: the poker run (my hand, my place, everyone's hands) and the bet board (`bet-board.tsx`).
 *  `Panel` is the console's panel; Games draws its own dark shell (owner's mockup, 7 Nov) and keeps the prop
 *  so console.tsx need not change. */
export function GamesPanel({ g, meId, campaignId }: { g: Games; meId: string; campaignId: string; Panel?: unknown }) {
  const now = useNow(60_000);
  const o = g.o;
  const link = `/games?campaign=${encodeURIComponent(campaignId)}`;
  if (!o) return null;
  const c = o.campaign && o.campaign.id === campaignId ? o.campaign : null;
  const betsOn = Boolean(c?.betsEnabled);
  const run = o.run && o.run.campaignId === campaignId ? o.run : null;
  if (!betsOn && !run) {
    return (
      <GamesShell link={link} defaultOpen={false}>
        <div className="text-sm text-zinc-400">Games are off for this campaign: no bets and no poker run. A supervisor switches them on from the campaign page.</div>
      </GamesShell>
    );
  }
  const mine = run?.rows.find((r) => r.userId === meId) ?? null;
  return (
    <GamesShell link={link}>
      {run ? (
        <section className="mb-5">
          <PokerRunCard run={run} row={mine} now={now} fresh={g.deal?.card ?? null}>
            <div className="mt-1 text-[11px] text-zinc-500">{placeLine(run.rows, meId)}</div>
          </PokerRunCard>
          <PokerTable run={run} meId={meId} max={6} pastRuns={o.pastRuns} />
        </section>
      ) : (
        <div className="mb-3 text-xs text-zinc-500">No poker run on this campaign right now.</div>
      )}
      {betsOn && c ? <BetBoard g={g} o={o} meId={meId} campaign={c} /> : <div className="text-xs text-zinc-500">Bets are off for this campaign.</div>}
    </GamesShell>
  );
}
