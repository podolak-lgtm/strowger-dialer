"use client";

// "Numbers for this list" (owner, 6 Nov): what a campaign, or one of its
// lists, needs in caller-ID numbers per area code, what it has, what the pool
// can lend and what is left to order, with one button that does it. Used on
// the import report, the list page, the campaign's Dialing tab and the new
// campaign setup. The button acts at once (with a confirm); it is never part
// of the campaign's Save.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { applyDidPlan, getDidPlan, type ApplyResult, type PlanOpts, type PlanView } from "@/app/(app)/numbers/plan-actions";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function NumbersCard({ campaignId, listId = null, scope = listId ? "list" : "campaign" }: { campaignId: string; listId?: string | null; scope?: "list" | "campaign" }) {
  const router = useRouter();
  const [opts, setOpts] = useState<PlanOpts>({ poolFirst: true, exactOnly: false });
  const [view, setView] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);

  async function load(o: PlanOpts) {
    setLoading(true);
    const r = await getDidPlan(campaignId, listId, o);
    if (r.ok) {
      setView(r.view);
      setError(null);
    } else setError(r.error);
    setLoading(false);
  }

  useEffect(() => {
    const t = setTimeout(() => void load({ poolFirst: true, exactOnly: false }), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, listId]);

  const change = (next: PlanOpts) => {
    setOpts(next);
    void load(next);
  };

  const p = view?.plan;
  const take = p?.totals.take ?? 0;
  const order = p?.totals.order ?? 0;
  const what = scope === "list" ? "this list" : "this campaign";
  const exactForced = view?.campaign.callerIdFallback === "EXACT_ONLY";

  async function apply() {
    if (!view || !p) return;
    const parts = [
      take ? `take ${take} number${take === 1 ? "" : "s"} from the pool` : "",
      order ? `order ${order} new number${order === 1 ? "" : "s"} from Telnyx at ${money(p.priceCents)} a month each (${money(p.monthlyOrderCents)} a month)` : "",
    ].filter(Boolean);
    if (!window.confirm(`For ${view.campaign.name}: ${parts.join(" and ")}? They are pinned to the campaign for local presence. This happens now, separately from any unsaved changes.`)) return;
    setApplying(true);
    setResult(null);
    const r = await applyDidPlan(campaignId, listId, opts);
    setApplying(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setResult(r.result);
    await load(opts);
    router.refresh();
  }

  const label = take && order ? `Take ${take} from the pool and order ${order} number${order === 1 ? "" : "s"}` : take ? `Take ${take} number${take === 1 ? "" : "s"} from the pool` : `Order ${order} number${order === 1 ? "" : "s"}`;

  return (
    <div className="space-y-3 text-sm">
      {error ? <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-red-200">{error}</div> : null}
      {!p ? (
        <p className="text-zinc-500">{loading ? "Working out the numbers…" : "No plan."}</p>
      ) : p.rows.length === 0 ? (
        <p className="text-zinc-400">No dialable leads in {what} yet; nothing to plan.</p>
      ) : (
        <>
          <p className="text-zinc-300">
            Over an average week {what} needs <b>{p.totals.needed}</b> number{p.totals.needed === 1 ? "" : "s"} in <b>{p.rows.length}</b> area code{p.rows.length === 1 ? "" : "s"} ({p.totals.dailyDials.toLocaleString()} dials a day for{" "}
            {p.totals.leads.toLocaleString()} leads). The campaign has {p.totals.have}.
          </p>
          <div className="overflow-x-auto rounded-md border border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900 text-left uppercase tracking-wide text-zinc-500">
                <tr>
                  {["Area code", "Leads", "Dials/day", "Need", "Have", "Pool", "Take", "Order"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 tabular-nums">
                {p.rows.map((r) => (
                  <tr key={r.areaCode}>
                    <td className="px-2 py-1.5">
                      <span className="font-mono text-zinc-100">{r.areaCode}</span> <span className="text-zinc-500">{r.state ?? ""}</span>
                      {r.folded.length ? <div className="text-[10px] text-zinc-500">+ {r.folded.join(", ")}</div> : null}
                    </td>
                    <td className="px-2 py-1.5">{r.leads.toLocaleString()}</td>
                    <td className="px-2 py-1.5">{r.dailyDials.toLocaleString()}</td>
                    <td className="px-2 py-1.5 font-semibold">{r.needed}</td>
                    <td className="px-2 py-1.5">{r.have}</td>
                    <td className="px-2 py-1.5 text-zinc-400">{r.poolCandidates}</td>
                    <td className="px-2 py-1.5">
                      {r.takeExact + r.takeState}
                      {r.takeState ? <span className="text-[10px] text-amber-300"> ({r.takeState} same state)</span> : null}
                    </td>
                    <td className={`px-2 py-1.5 ${r.toOrder ? "font-semibold text-sky-300" : ""}`}>{r.toOrder}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zinc-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={opts.poolFirst} disabled={loading || applying} onChange={(e) => change({ ...opts, poolFirst: e.target.checked })} /> Use numbers from the pool before ordering
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={opts.exactOnly || exactForced} disabled={loading || applying || exactForced} onChange={(e) => change({ ...opts, exactOnly: e.target.checked })} /> Exact area codes only (no same-state
              stand-ins)
            </label>
          </div>
          <div className="text-zinc-400">
            Take from pool <b className="text-zinc-200">{take}</b> · order <b className="text-zinc-200">{order}</b> · new numbers {money(p.monthlyOrderCents)}/month ({money(p.priceCents)} each) · all {p.totals.have + p.totals.surplus + take + order}{" "}
            numbers on the campaign {money(p.monthlyAllCents)}/month
            {p.totals.surplus ? <span> · {p.totals.surplus} pinned in area codes this plan does not need</span> : null}
          </div>
          {take + order === 0 ? (
            <div className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-emerald-200">You have enough numbers for {what}.</div>
          ) : (
            <button type="button" onClick={() => void apply()} disabled={applying || loading} className="rounded-md bg-emerald-400 px-3 py-1.5 font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50">
              {applying ? "Working…" : label}
            </button>
          )}
        </>
      )}
      {result ? <ResultNote r={result} /> : null}
      {view?.notes.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-200/80">
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {p ? (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Assumes each lead is dialled {p.assumptions.dialsPerLeadPerDay} time{p.assumptions.dialsPerLeadPerDay === 1 ? "" : "s"} on its day (the campaign&apos;s attempt rule, at most 3) and the leads are spread over {p.assumptions.listDays} working
          days; {p.assumptions.numberCap} dials a day per number, new numbers sized at {p.assumptions.newNumberCap} while they warm up; {Math.round(p.assumptions.spareFactor * 100)}% spare for rotation and rest (at least {p.assumptions.minSpare});
          area codes under {p.assumptions.minLeadsPerAreaCode} leads a week share their state&apos;s busiest area code. Pool = shared numbers not pinned to any campaign; same-state pool numbers stand in unless you ask for exact area codes.
        </p>
      ) : null}
    </div>
  );
}

function ResultNote({ r }: { r: ApplyResult }) {
  const ordered = r.ordered.reduce((n, o) => n + o.phones.length, 0);
  return (
    <div className={`rounded-md border px-3 py-2 ${r.error ? "border-amber-900 bg-amber-950/40 text-amber-200" : "border-emerald-900 bg-emerald-950/40 text-emerald-200"}`}>
      <div>
        Took {r.taken.length} from the pool, ordered {ordered} new number{ordered === 1 ? "" : "s"}
        {ordered ? " (they finish registering in jambonz within a few minutes, then need the Free Caller Registry on the DIDs page before they dial)" : ""}.
      </div>
      {r.short.map((s) => (
        <div key={`${s.areaCode}-${s.reason}`} className="text-xs">
          {s.areaCode}: {s.count} · {s.reason}
        </div>
      ))}
      {r.error ? <div className="text-xs">{r.error}</div> : null}
    </div>
  );
}
