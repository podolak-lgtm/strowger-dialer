"use client";

// Script & rebuttals (side by side, "Load template" in each card header,
// History of script versions) and Games (bets in the draft; the poker run
// starts and ends at once, with a confirm).
import { useState, type ReactNode } from "react";
import { outcomeNoun, prettyCard } from "@strowger/shared/games";
import { PokerRuleFields } from "@/components/poker-run-fields";
import { Badge } from "@/components/ui";
import { endRunForm, startRunForm } from "../games-actions";
import { AddButton, Card, FieldBox, Hint, cls, useEditor } from "./editor-ui";

type Option = { key: string; name: string; text: string };
export interface ScriptVersion {
  version: number;
  createdAt: string;
  body: string;
}

function TemplatePicker({ options, label, current, onLoad }: { options: Option[]; label: string; current: string; onLoad: (text: string) => void }) {
  const [picked, setPicked] = useState(options[0]?.key ?? "");
  if (!options.length) return null;
  return (
    <>
      <select aria-label={`${label} template`} value={picked} onChange={(e) => setPicked(e.target.value)} className={cls(undefined, "w-40 py-1 text-xs")}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
      <AddButton
        onClick={() => {
          const t = options.find((o) => o.key === picked);
          if (!t) return;
          if (current.trim() && current !== t.text && !window.confirm("Replace what is in the box with the template? Nothing is saved until you press Save campaign.")) return;
          onLoad(t.text);
        }}
      >
        {label}
      </AddButton>
    </>
  );
}

export function ScriptTab({ scriptOptions, rebuttalOptions, versions, versionCount, rebuttalPlaceholder }: { scriptOptions: Option[]; rebuttalOptions: Option[]; versions: ScriptVersion[]; versionCount: number; rebuttalPlaceholder: string }) {
  const { draft, edit, errors } = useEditor();
  const [history, setHistory] = useState(false);
  const latest = versions[0];
  const setScript = (script: string) => edit((d) => ({ ...d, script }));
  const setRebuttals = (rebuttals: string) => edit((d) => ({ ...d, rebuttals }));
  const area = "h-[calc(100vh-24rem)] min-h-56 max-h-[36rem] resize-y font-mono text-xs leading-relaxed";
  return (
    <>
      <Card
        title={`Agent script${latest ? ` (version ${latest.version})` : ""}`}
        actions={
          <>
            <TemplatePicker options={scriptOptions} label="Load script" current={draft.script} onLoad={setScript} />
            {versionCount ? (
              <button type="button" onClick={() => setHistory((h) => !h)} className="text-xs text-sky-400 hover:underline" aria-expanded={history}>
                History ({versionCount})
              </button>
            ) : null}
          </>
        }
      >
        {history ? (
          <div className="mb-2 max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
            {versions.map((v) => (
              <div key={v.version} className="flex items-center gap-2 py-0.5">
                <b className="w-8 shrink-0 text-zinc-300">v{v.version}</b>
                <span className="w-36 shrink-0 text-zinc-500">{v.createdAt}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-400">{v.body.split("\n")[0] || "(empty)"}</span>
                <button
                  type="button"
                  className="shrink-0 text-sky-400 hover:underline"
                  onClick={() => {
                    if (draft.script.trim() && draft.script !== v.body && !window.confirm(`Put version ${v.version} in the box? Save campaign then keeps it as a new version.`)) return;
                    setScript(v.body);
                  }}
                >
                  Load
                </button>
              </div>
            ))}
            {versionCount > versions.length ? <div className="pt-1 text-zinc-500">Showing the latest {versions.length} of {versionCount}.</div> : null}
          </div>
        ) : null}
        <FieldBox label="What agents read on the assist screen" error={errors["script.body"]}>
          <textarea name="body" data-field="script.body" value={draft.script} onChange={(e) => setScript(e.target.value)} placeholder={"Hi {{first_name}}, this is {{agent}} with {{company}}. You asked about…"} className={cls(errors["script.body"], area)} />
        </FieldBox>
        <Hint more="Variables: {{first_name}}, {{last_name}}, {{agent}}, {{company}}, {{city}}, {{state}}. Every save keeps the old version: Save campaign adds a new version only when the text changed. Loading a template only fills the box.">Every save keeps the old version.</Hint>
      </Card>

      <Card title="Agent assist: rebuttals" actions={<TemplatePicker options={rebuttalOptions} label="Load rebuttals" current={draft.rebuttals} onLoad={setRebuttals} />}>
        <FieldBox label="Objection | what to say (one per line)">
          <textarea name="rebuttals" data-field="script.rebuttals" value={draft.rebuttals} onChange={(e) => setRebuttals(e.target.value)} placeholder={rebuttalPlaceholder} className={cls(undefined, area)} />
        </FieldBox>
        <Hint more="Agents see these on the Assist panel while on a call, and the AI suggestions lean on them first. Lines without a “|” are dropped on Save; at most 200.">Shown on the agent&apos;s Assist panel.</Hint>
      </Card>
    </>
  );
}

export interface RunView {
  id: string;
  name: string;
  prize: string | null;
  status: string;
  qualifies: string;
  qualifyingCodes: string[];
  outcomesPerCard: number;
  window: string;
  liveLabel: string;
  live: boolean;
  endedAt: string | null;
  winner: { name: string; hand: string; cards: string[] } | null;
}

function Confirmed({ action, message, children, className }: { action: (fd: FormData) => Promise<void>; message: string; children: ReactNode; className?: string }) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </form>
  );
}

export function GamesTab({ campaignId, runs, error, runDefaults }: { campaignId: string; runs: RunView[]; error?: string; runDefaults: { startsAt: string; endsAt: string } }) {
  const { draft, edit, errors } = useEditor();
  const set = (p: Partial<typeof draft.bets>) => edit((d) => ({ ...d, bets: { ...d.bets, ...p } }));
  const active = runs.find((r) => r.status === "ACTIVE") ?? null;
  const past = runs.filter((r) => r.status === "ENDED").slice(0, 5);
  return (
    <>
      <Card title="Bets">
        <div className="space-y-2.5">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="betsEnabled" data-field="games.betsEnabled" checked={draft.bets.betsEnabled} onChange={(e) => set({ betsEnabled: e.target.checked })} className="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
            Agents on this campaign may bet points against each other
          </label>
          {errors["games.betsEnabled"] ? <div className="text-xs text-red-400">{errors["games.betsEnabled"]}</div> : null}
          <div className="grid grid-cols-2 gap-3">
            <FieldBox label="Points every Monday">
              <input name="weeklyPoints" type="number" min={0} value={draft.bets.weeklyPoints} onChange={(e) => set({ weeklyPoints: e.target.value })} className={cls(undefined)} />
            </FieldBox>
            <FieldBox label="Max stake per bet">
              <input name="maxStake" type="number" min={1} value={draft.bets.maxStake} onChange={(e) => set({ maxStake: e.target.value })} className={cls(undefined)} />
            </FieldBox>
          </div>
          <Hint>Switching bets on tops up every agent on the campaign to the Monday allowance at once (on Save), and tells their consoles.</Hint>
        </div>
      </Card>

      <Card title="Poker run">
        {error ? <div className="mb-3 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div> : null}
        {active ? (
          <Confirmed action={endRunForm} message={`End “${active.name}” now and name the winner?`} className="space-y-2 rounded-md border border-fuchsia-900/60 bg-fuchsia-950/20 p-3 text-sm">
            <input type="hidden" name="campaignId" value={campaignId} />
            <input type="hidden" name="runId" value={active.id} />
            <div className="flex items-center justify-between gap-2">
              <b>{active.name}</b>
              <Badge tone={active.live ? "green" : "amber"}>{active.liveLabel}</Badge>
            </div>
            <div className="text-xs text-zinc-400">
              {active.window} · {active.prize ? `Prize: ${active.prize}` : "No prize text"} · A card for every {outcomeNoun(active.qualifies, active.outcomesPerCard, active.qualifyingCodes)} · 7 cards max
            </div>
            <button type="submit" className="rounded-md border border-red-900 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-950">
              End the run now and name the winner
            </button>
          </Confirmed>
        ) : (
          <Confirmed action={startRunForm} message="Start this poker run now? Agents on the campaign are told at once." className="space-y-2">
            <input type="hidden" name="campaignId" value={campaignId} />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <FieldBox label="Name">
                <input name="name" required maxLength={80} className={cls(undefined)} placeholder="Friday showdown" />
              </FieldBox>
              <FieldBox label="Prize (shown to agents)">
                <input name="prize" maxLength={120} className={cls(undefined)} placeholder="$100 gift card" />
              </FieldBox>
              <FieldBox label="Period">
                <select name="period" defaultValue="week" className={cls(undefined)}>
                  <option value="week">This week (Monday to Sunday, UTC)</option>
                  <option value="custom">Custom dates below</option>
                </select>
              </FieldBox>
              <FieldBox label="Starts (custom)">
                <input name="startsAt" type="datetime-local" defaultValue={runDefaults.startsAt} className={cls(undefined)} />
              </FieldBox>
              <FieldBox label="Ends (custom)">
                <input name="endsAt" type="datetime-local" defaultValue={runDefaults.endsAt} className={cls(undefined)} />
              </FieldBox>
              <PokerRuleFields inputClass={cls(undefined)} labelClass="mb-1 block text-xs font-medium text-zinc-400" />
            </div>
            <button type="submit" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800">
              Start the run
            </button>
            <p className="text-xs text-zinc-500">Starting or ending a run acts at once; it is not part of Save campaign.</p>
          </Confirmed>
        )}
        {past.length ? (
          <p className="mt-2 truncate text-xs text-zinc-400" title={past.map((r) => `${r.name}: ${r.winner ? `${r.winner.name} won with ${r.winner.hand} (${r.winner.cards.map(prettyCard).join(" ")})` : "nobody held a card"}${r.prize ? ` · ${r.prize}` : ""}`).join("\n")}>
            Past runs:{" "}
            {past.map((r, i) => (
              <span key={r.id}>
                {i ? " · " : ""}
                <b className="text-zinc-300">{r.name}</b> ({r.endedAt}) {r.winner ? `${r.winner.name}, ${r.winner.hand} ${r.winner.cards.map(prettyCard).join(" ")}` : "no winner"}
                {r.prize ? `, ${r.prize}` : ""}
              </span>
            ))}
          </p>
        ) : null}
      </Card>
    </>
  );
}
