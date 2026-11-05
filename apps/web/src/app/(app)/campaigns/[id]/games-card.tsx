import { POKER_QUALIFIERS, daysLeft, prettyCard, runIsLive } from "@strowger/shared/games";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { endRunForm, saveCampaignBets, startRunForm } from "../games-actions";

type Run = { id: string; name: string; prize: string | null; startsAt: Date; endsAt: Date; status: string; qualifies: string; qualifyingCodes: string[]; winningHand: unknown; endedAt: Date | null };

/** Campaign page → Games: bets on/off with allowance and stake cap; start or end the campaign's poker run. */
export function GamesCard({ campaign, runs, error, now }: { campaign: { id: string; betsEnabled: boolean; weeklyPoints: number; maxStake: number }; runs: Run[]; error?: string; now: Date }) {
  const active = runs.find((r) => r.status === "ACTIVE") ?? null;
  const past = runs.filter((r) => r.status === "ENDED").slice(0, 5);
  const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const nextWeek = new Date(now.getTime() + 7 * 86_400_000);
  return (
    <div id="games" className="scroll-mt-6 lg:col-span-2">
      <Card title="Games">
        {error ? <div className="mb-3 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div> : null}
        <div className="grid gap-6 lg:grid-cols-2">
          <form action={saveCampaignBets} className="space-y-3">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Bets</h3>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="betsEnabled" defaultChecked={campaign.betsEnabled} className="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
              Agents on this campaign may bet points against each other
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Points every Monday">
                <input name="weeklyPoints" type="number" min={0} defaultValue={campaign.weeklyPoints} className={inputClass} />
              </Field>
              <Field label="Max stake per bet">
                <input name="maxStake" type="number" min={1} defaultValue={campaign.maxStake} className={inputClass} />
              </Field>
            </div>
            <p className="text-xs text-zinc-500">Switching bets on tops up every agent on the campaign to the Monday allowance at once, and tells their consoles.</p>
            <Button type="submit" variant="ghost">
              Save bets
            </Button>
          </form>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Poker run</h3>
            {active ? (
              <form action={endRunForm} className="space-y-2 rounded-md border border-fuchsia-900/60 bg-fuchsia-950/20 p-3 text-sm">
                <input type="hidden" name="campaignId" value={campaign.id} />
                <input type="hidden" name="runId" value={active.id} />
                <div className="flex items-center justify-between">
                  <b>{active.name}</b>
                  <Badge tone={runIsLive(active, now) ? "green" : "amber"}>{runIsLive(active, now) ? `${daysLeft(active.endsAt, now)} days left` : active.startsAt > now ? "starts later" : "past its end"}</Badge>
                </div>
                <div className="text-xs text-zinc-400">
                  {active.startsAt.toUTCString().slice(0, 16)} → {active.endsAt.toUTCString().slice(0, 16)} · {active.prize ? `Prize: ${active.prize}` : "No prize text"} · {active.qualifies === "CODES" ? `Card for ${active.qualifyingCodes.join(", ")}` : POKER_QUALIFIERS[active.qualifies as keyof typeof POKER_QUALIFIERS] ?? active.qualifies}
                </div>
                <Button type="submit" variant="danger">
                  End the run now and name the winner
                </Button>
              </form>
            ) : (
              <form action={startRunForm} className="space-y-2">
                <input type="hidden" name="campaignId" value={campaign.id} />
                <Field label="Name">
                  <input name="name" required maxLength={80} className={inputClass} placeholder="Friday showdown" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Period">
                    <select name="period" defaultValue="week" className={inputClass}>
                      <option value="week">This week (Monday to Sunday, UTC)</option>
                      <option value="custom">Custom dates below</option>
                    </select>
                  </Field>
                  <Field label="Prize (shown to agents)">
                    <input name="prize" maxLength={120} className={inputClass} placeholder="$100 gift card" />
                  </Field>
                  <Field label="Starts (custom)">
                    <input name="startsAt" type="datetime-local" defaultValue={localInput(now)} className={inputClass} />
                  </Field>
                  <Field label="Ends (custom)">
                    <input name="endsAt" type="datetime-local" defaultValue={localInput(nextWeek)} className={inputClass} />
                  </Field>
                  <Field label="What deals a card">
                    <select name="qualifies" defaultValue="SALE" className={inputClass}>
                      {Object.entries(POKER_QUALIFIERS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Disposition codes (for that choice)" hint="Comma-separated, e.g. SALE, XFER">
                    <input name="codes" className={inputClass} placeholder="SALE, XFER" />
                  </Field>
                </div>
                <Button type="submit" variant="ghost">
                  Start the run
                </Button>
              </form>
            )}
            {past.length ? (
              <ul className="space-y-1 text-xs text-zinc-400">
                {past.map((r) => {
                  const w = r.winningHand as { name: string; hand: string; cards: string[] } | null;
                  return (
                    <li key={r.id}>
                      <b className="text-zinc-300">{r.name}</b> ended {r.endedAt?.toUTCString().slice(5, 16)}: {w ? `${w.name} won with ${w.hand} (${w.cards.map(prettyCard).join(" ")})` : "nobody held a card"}
                      {r.prize ? ` · ${r.prize}` : ""}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
