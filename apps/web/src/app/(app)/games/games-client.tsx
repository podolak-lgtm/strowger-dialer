"use client";

import { useCallback, useEffect, useState } from "react";
import { WAGER_NOTE_MAX, outcomeNoun, placeLine } from "@strowger/shared/games";
import { PlayingCard } from "@/components/playing-card";
import { PokerRuleFields } from "@/components/poker-run-fields";
import { PokerRunCard, PokerTable } from "@/components/poker-run";
import { endPokerRun, gamesOverview, setCampaignBets, startPokerRun, wager, type GamesOverview, type RunSummary } from "@/lib/games-actions";

export function GamesClient({ meId, people, canPlay, canManage, initialCampaignId }: { meId: string; people: { id: string; name: string }[]; canPlay: boolean; canManage: boolean; initialCampaignId: string | null }) {
  const [o, setO] = useState<GamesOverview | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId);
  const [kind, setKind] = useState("NEXT_SALE");
  const [stake, setStake] = useState(500);
  const [against, setAgainst] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const refresh = useCallback(() => void gamesOverview(campaignId).then(setO).catch(() => undefined), [campaignId]);
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
  const c = o.campaign;
  const mine = o.run?.rows.find((r) => r.userId === meId);
  const open = o.wagers.filter((w) => w.status === "OPEN");
  const live = o.wagers.filter((w) => w.status === "ACCEPTED");
  const betsOn = Boolean(c?.betsEnabled);

  const picker = (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex min-w-0 max-w-full items-center gap-2">
        <span className="text-zinc-400">Campaign</span>
        <select value={c?.id ?? ""} onChange={(e) => setCampaignId(e.target.value || null)} className="min-w-0 max-w-full flex-1 truncate rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5">
          {o.campaigns.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.betsEnabled ? " · bets on" : ""}
              {x.run ? ` · ${x.run.name}` : ""}
            </option>
          ))}
        </select>
      </label>
      {c ? (
        <span className="text-xs text-zinc-500">
          {betsOn ? `Bets on · ${c.weeklyPoints.toLocaleString()} points every Monday · max stake ${c.maxStake.toLocaleString()}` : "Bets are off for this campaign"}
          {o.run ? ` · Poker run "${o.run.name}"${o.run.live ? ` · ${o.run.daysLeft} days left` : ""}` : " · no poker run"}
        </span>
      ) : null}
    </div>
  );

  if (!c) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-zinc-500">{canManage ? "No active campaigns yet. Games are switched on per campaign from its page." : "You are not on an active campaign, so there are no games for you yet."}</div>
      </div>
    );
  }

  return (
    <div>
      {picker}
      {canManage ? <ManageCard o={o} busy={busy} setBusy={setBusy} refresh={refresh} setMsg={setMsg} /> : null}
      {!betsOn && !o.run ? <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-400">Games are off for <b className="text-zinc-200">{c.name}</b>: no bets and no poker run. {canManage ? "Switch bets on or start a run above." : "A supervisor switches them on from the campaign page."}</div> : null}
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <section className="space-y-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">My points</h2>
            <span className="text-xs text-zinc-500">{betsOn ? `${c.weeklyPoints.toLocaleString()} every Monday` : "bets off here"}</span>
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
              <span className="text-zinc-300">Stake (max {c.maxStake.toLocaleString()})</span>
              <input type="number" min={1} max={c.maxStake} value={stake} onChange={(e) => setStake(Number(e.target.value))} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
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
              <input value={note} onChange={(e) => setNote(e.target.value.slice(0, WAGER_NOTE_MAX))} maxLength={WAGER_NOTE_MAX} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
            </label>
          </div>
          <button disabled={busy || !canPlay || !betsOn || stake <= 0} onClick={() => void act({ action: "propose", campaignId: c.id, kind, stake, accepterId: against || null, note })} className="mt-3 rounded-md bg-fuchsia-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
            Put it up
          </button>
          {!betsOn ? <span className="ml-3 text-xs text-zinc-500">Bets are off for {c.name}.</span> : !canPlay ? <span className="ml-3 text-xs text-zinc-500">Your level cannot place bets yet.</span> : null}
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
                ) : w.actions.includes("accept") ? (
                  <span className="flex gap-1">
                    <button disabled={busy || !canPlay || !betsOn} onClick={() => void act({ action: "accept", wagerId: w.id })} className="rounded bg-emerald-400 px-2 py-1 text-xs font-semibold text-emerald-950 disabled:opacity-40">
                      {w.accepterId === meId ? "Accept" : "Take it"}
                    </button>
                    {w.actions.includes("decline") ? (
                      <button disabled={busy} onClick={() => void act({ action: "decline", wagerId: w.id })} className="rounded border border-white/10 px-2 py-1 text-xs hover:bg-white/10">
                        Decline
                      </button>
                    ) : null}
                  </span>
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
                    {w.short}: {w.proposer} vs {w.accepter} ·{" "}
                    {w.winnerId ? (w.winnerId === meId ? <span className="text-emerald-300">you won {(w.stake * 2).toLocaleString()}</span> : <span className={w.proposerId === meId || w.accepterId === meId ? "text-red-300" : "text-zinc-200"}>{w.winnerId === w.proposerId ? w.proposer : w.accepter} won {(w.stake * 2).toLocaleString()}</span>) : "push"}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        {o.run ? (
          <div>
            <PokerRunCard run={o.run} row={canPlay ? (mine ?? null) : (o.run.rows[0] ?? null)} now={now} handTitle={canPlay ? "Your Best Hand" : `Leading hand${o.run.rows[0] ? ` (${o.run.rows[0].name})` : ""}`}>
              <p className="mt-2 text-[11px] text-zinc-500">
                {ruleText(o.run)} Ends {new Date(o.run.endsAt).toLocaleString()}.{canPlay ? ` ${placeLine(o.run.rows, meId)}.` : ""}
              </p>
            </PokerRunCard>
            <PokerTable run={o.run} meId={meId} />
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Poker run</h2>
            <p className="mt-1 text-sm text-zinc-500">No poker run on {c.name} right now.</p>
          </div>
        )}
        {o.pastRuns.length ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Past runs</h2>
            <ul className="space-y-2 text-sm">
              {o.pastRuns.map((r) => (
                <li key={r.id} className="rounded-md bg-white/5 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <b>{r.name}</b>
                    <span className="text-xs text-zinc-500">ended {r.endedAt ? new Date(r.endedAt).toLocaleDateString() : ""}{r.prize ? ` · ${r.prize}` : ""}</span>
                  </div>
                  {r.winner ? (
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span className={r.winner.userId === meId ? "text-emerald-300" : "text-zinc-300"}>{r.winner.userId === meId ? "You won" : `${r.winner.name} won`} with {r.winner.hand}</span>
                      <span className="flex gap-0.5">
                        {r.winner.cards.map((c) => (
                          <PlayingCard key={c} card={c} size="sm" />
                        ))}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-zinc-500">Nobody held a card.</div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
    </div>
  );
}

function ruleText(r: RunSummary): string {
  return `A card for every ${outcomeNoun(r.qualifies, r.outcomesPerCard, r.codes)}, seven at most; the best five win.`;
}

/** Supervisors, admins and team leaders with `manage_games`: bets on/off and the poker run for the selected campaign. */
function ManageCard({ o, busy, setBusy, refresh, setMsg }: { o: GamesOverview; busy: boolean; setBusy: (b: boolean) => void; refresh: () => void; setMsg: (m: string | null) => void }) {
  const c = o.campaign!;
  const [err, setErr] = useState<string | null>(null);
  const [opened] = useState(() => new Date());
  const run = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    const r = await fn();
    setErr(r.ok ? null : r.error);
    if (r.ok) setMsg(null);
    setBusy(false);
    refresh();
  };
  const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return (
    <div className="mb-6 rounded-lg border border-amber-900/50 bg-amber-950/10 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-200/80">Run the games on {c.name}</h2>
      {err ? <div className="mb-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">{err}</div> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          key={`bets-${c.id}-${c.betsEnabled}-${c.weeklyPoints}-${c.maxStake}`}
          className="space-y-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(() => setCampaignBets({ campaignId: c.id, betsEnabled: f.get("betsEnabled") === "on", weeklyPoints: Number(f.get("weeklyPoints")), maxStake: Number(f.get("maxStake")) }));
          }}
        >
          <label className="flex items-center gap-2 text-zinc-300">
            <input type="checkbox" name="betsEnabled" defaultChecked={c.betsEnabled} className="h-4 w-4" /> Bets on for this campaign
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-zinc-400">Points every Monday</span>
              <input name="weeklyPoints" type="number" min={0} defaultValue={c.weeklyPoints} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
            </label>
            <label className="block">
              <span className="text-zinc-400">Max stake</span>
              <input name="maxStake" type="number" min={1} defaultValue={c.maxStake} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
            </label>
          </div>
          <button disabled={busy} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
            Save bets
          </button>
        </form>

        {o.run ? (
          <div className="space-y-2 text-sm">
            <div>
              Poker run <b>{o.run.name}</b> · {o.run.live ? `${o.run.daysLeft} days left` : "outside its window"}
              {o.run.prize ? ` · ${o.run.prize}` : ""}
            </div>
            <div className="text-xs text-zinc-500">{ruleText(o.run)} Ends {new Date(o.run.endsAt).toLocaleString()}; it closes itself then, or end it now.</div>
            <button disabled={busy} onClick={() => void run(() => endPokerRun(o.run!.id))} className="rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40">
              End the run now and name the winner
            </button>
          </div>
        ) : (
          <form
            key={`run-${c.id}`}
            className="space-y-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const period = String(f.get("period"));
              let startsAt = new Date(String(f.get("startsAt"))).toISOString();
              let endsAt = new Date(String(f.get("endsAt"))).toISOString();
              if (period === "week") {
                const now = new Date();
                const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
                const day = t.getUTCDay() || 7;
                const monday = new Date(t.getTime() - (day - 1) * 86_400_000);
                startsAt = monday.toISOString();
                endsAt = new Date(monday.getTime() + 7 * 86_400_000).toISOString();
              }
              void run(() => startPokerRun({ campaignId: c.id, name: String(f.get("name") ?? ""), startsAt, endsAt, prize: String(f.get("prize") ?? ""), qualifies: String(f.get("qualifies") ?? "SALE"), codes: String(f.get("codes") ?? ""), outcomesPerCard: Number(f.get("outcomesPerCard") ?? 1) || 1 }));
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 block">
                <span className="text-zinc-400">Start a poker run: name</span>
                <input name="name" required maxLength={80} placeholder="Friday showdown" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-zinc-400">Period</span>
                <select name="period" defaultValue="week" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2">
                  <option value="week">This week (Mon–Sun, UTC)</option>
                  <option value="custom">Custom dates</option>
                </select>
              </label>
              <label className="block">
                <span className="text-zinc-400">Prize</span>
                <input name="prize" maxLength={120} placeholder="$100 gift card" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-zinc-400">Starts (custom)</span>
                <input name="startsAt" type="datetime-local" defaultValue={localInput(opened)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
              </label>
              <label className="block">
                <span className="text-zinc-400">Ends (custom)</span>
                <input name="endsAt" type="datetime-local" defaultValue={localInput(new Date(opened.getTime() + 7 * 86_400_000))} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" />
              </label>
              <PokerRuleFields inputClass="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2" codesListId={`codes-${c.id}`} codesPlaceholder={o.dispositions.filter((d) => d.isSale).map((d) => d.code).join(", ") || "SALE, XFER"} />
              <datalist id={`codes-${c.id}`}>
                {o.dispositions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.label}
                  </option>
                ))}
              </datalist>
            </div>
            <button disabled={busy} className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-950 disabled:opacity-40">
              Start the run
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
