"use client";

import { useCallback, useEffect, useState } from "react";
import { prettyCard } from "@strowger/shared/games";
import { gamesOverview, wager, type GamesOverview } from "@/lib/games-actions";

const CardFace = ({ c, dim = false }: { c: string; dim?: boolean }) => {
  const red = c[1] === "H" || c[1] === "D";
  return <span className={`inline-grid h-9 w-7 place-items-center rounded border text-xs font-bold ${dim ? "border-zinc-700 bg-zinc-900 text-zinc-500" : `border-zinc-300 bg-white ${red ? "text-red-600" : "text-zinc-900"}`}`}>{prettyCard(c)}</span>;
};

export function GamesClient({ meId, people, canPlay }: { meId: string; people: { id: string; name: string }[]; canPlay: boolean }) {
  const [o, setO] = useState<GamesOverview | null>(null);
  const [kind, setKind] = useState("NEXT_SALE");
  const [stake, setStake] = useState(500);
  const [against, setAgainst] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => void gamesOverview().then(setO).catch(() => undefined), []);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  const act = async (input: Parameters<typeof wager>[0]) => {
    setBusy(true);
    const r = await wager(input);
    setMsg(r.ok ? null : r.error);
    setBusy(false);
    refresh();
  };

  if (!o) return <div className="text-sm text-zinc-500">Loading…</div>;
  if (!o.settings.enabled) return <div className="text-sm text-zinc-500">Games are switched off for this workspace.</div>;
  const mine = o.poker.rows.find((r) => r.userId === meId);
  const open = o.wagers.filter((w) => w.status === "OPEN");
  const live = o.wagers.filter((w) => w.status === "ACCEPTED");

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <section className="space-y-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">My points</h2>
            <span className="text-xs text-zinc-500">{o.settings.weeklyPoints.toLocaleString()} every Monday</span>
          </div>
          <div className="mt-1 text-4xl font-semibold tabular-nums">{o.points.toLocaleString()}</div>
          <ul className="mt-3 space-y-1 text-xs text-zinc-400">
            {o.ledger.slice(0, 6).map((l, i) => (
              <li key={i} className="flex justify-between">
                <span className="truncate">{l.reason}</span>
                <span className={`ml-2 tabular-nums ${l.delta >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                  {l.delta >= 0 ? "+" : ""}
                  {l.delta.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Make a bet</h2>
          {msg ? <div className="mb-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">{msg}</div> : null}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="block">
              <span className="text-zinc-300">On</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2">
                {o.kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-zinc-300">Stake (max {o.settings.maxStake.toLocaleString()})</span>
              <input type="number" min={1} max={o.settings.maxStake} value={stake} onChange={(e) => setStake(Number(e.target.value))} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
            </label>
            <label className="block">
              <span className="text-zinc-300">Against</span>
              <select value={against} onChange={(e) => setAgainst(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2">
                <option value="">Anyone who takes it</option>
                {people
                  .filter((p) => p.id !== meId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              <span className="text-zinc-300">Trash talk (optional)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
            </label>
          </div>
          <button disabled={busy || !canPlay || stake <= 0} onClick={() => void act({ action: "propose", kind, stake, accepterId: against || null, note })} className="mt-3 rounded-md bg-fuchsia-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            Put it up
          </button>
          {!canPlay ? <span className="ml-3 text-xs text-zinc-500">Your level cannot place bets yet.</span> : null}
          <p className="mt-2 text-xs text-zinc-500">&ldquo;Next …&rdquo; bets settle the moment it happens to either of you. &ldquo;Most … today/this week&rdquo; bets settle when the period ends; a tie returns both stakes.</p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Open bets ({open.length})</h2>
          <ul className="space-y-2 text-sm">
            {open.map((w) => (
              <li key={w.id} className="flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
                <div>
                  <div>
                    <b>{w.proposer}</b> · {w.label} · <span className="tabular-nums text-fuchsia-300">{w.stake.toLocaleString()}</span>
                    {w.accepterId ? <span className="text-zinc-500"> · for {w.accepter}</span> : null}
                  </div>
                  {w.note ? <div className="text-xs italic text-zinc-400">&ldquo;{w.note}&rdquo;</div> : null}
                </div>
                {w.proposerId === meId ? (
                  <button disabled={busy} onClick={() => void act({ action: "withdraw", wagerId: w.id })} className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/10">
                    Withdraw
                  </button>
                ) : !w.accepterId || w.accepterId === meId ? (
                  <button disabled={busy || !canPlay} onClick={() => void act({ action: "accept", wagerId: w.id })} className="rounded bg-emerald-400 px-2 py-1 text-xs font-semibold text-emerald-950 disabled:opacity-40">
                    Take it
                  </button>
                ) : null}
              </li>
            ))}
            {open.length === 0 ? <li className="text-xs text-zinc-500">Nothing on the table.</li> : null}
          </ul>
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Live ({live.length})</h3>
          <ul className="space-y-1 text-sm">
            {live.map((w) => (
              <li key={w.id} className="rounded-md bg-white/5 px-3 py-2">
                <b>{w.proposer}</b> vs <b>{w.accepter}</b> · {w.label} · <span className="tabular-nums text-fuchsia-300">{w.stake.toLocaleString()}</span> each
              </li>
            ))}
          </ul>
          {o.settled.length ? (
            <>
              <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Recently settled</h3>
              <ul className="space-y-1 text-xs text-zinc-400">
                {o.settled.map((w) => (
                  <li key={w.id}>
                    {w.label}: {w.winnerId ? (w.winnerId === meId ? <span className="text-emerald-300">you won {(w.stake * 2).toLocaleString()}</span> : <span className="text-red-300">{w.winnerId === w.proposerId ? w.proposer : w.accepter} won</span>) : "push"}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Poker run · {o.poker.pokerPeriod === "day" ? "today" : "this week"}</h2>
            <span className="text-xs text-zinc-500">{o.poker.prize ? `Prize: ${o.poker.prize}` : "Every sale deals a card"}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">One card per sale. Best five-card hand when the {o.poker.pokerPeriod} ends wins.</p>
          <div className="mt-3 rounded-md bg-black/30 p-3">
            <div className="mb-1 text-xs text-zinc-400">Your hand {mine?.hand ? `· ${mine.hand.name}` : ""}</div>
            <div className="flex flex-wrap gap-1">
              {(mine?.cards ?? []).map((c, i) => (
                <CardFace key={i} c={c} dim={Boolean(mine?.hand && !mine.hand.cards.includes(c))} />
              ))}
              {!mine?.cards.length ? <span className="text-xs text-zinc-500">No cards yet. Make a sale.</span> : null}
            </div>
          </div>
          <ol className="mt-3 space-y-1 text-sm">
            {o.poker.rows.map((r, i) => (
              <li key={r.userId} className={`flex items-center gap-2 rounded-md px-3 py-2 ${r.userId === meId ? "bg-emerald-400/10" : "bg-white/5"}`}>
                <span className="w-4 text-xs text-zinc-500">{i + 1}</span>
                <span className="flex-1 truncate">
                  {r.name} {r.hand ? <span className="text-xs text-zinc-400">· {r.hand.name}</span> : null}
                </span>
                <span className="flex gap-0.5">
                  {r.cards.slice(-5).map((c, j) => (
                    <CardFace key={j} c={c} />
                  ))}
                </span>
              </li>
            ))}
            {o.poker.rows.length === 0 ? <li className="text-xs text-zinc-500">Nobody has a card yet this {o.poker.pokerPeriod}.</li> : null}
          </ol>
        </div>
      </section>
    </div>
  );
}
