"use client";

// /platform → Accounting: one row per client for the month, sortable by any
// column, red when the margin % is under the floor (PlatformRates.marginFloorPct).
import { useState } from "react";
import { sortPnl, type PnlSortKey } from "@strowger/shared/accounting";
import { money } from "@/components/billing-badge";
import { Badge } from "@/components/ui";
import type { ClientPnlRow } from "@/lib/billing-actions";

const COLS: Array<{ key: PnlSortKey | null; label: string; title?: string }> = [
  { key: "name", label: "Client" },
  { key: "seats", label: "Seats" },
  { key: "minutes", label: "Minutes", title: "Billed talk minutes" },
  { key: "numbers", label: "Numbers", title: "Numbers held this month, pool included" },
  { key: "texts", label: "Texts", title: "Segments sent" },
  { key: "revenueCents", label: "Revenue" },
  { key: null, label: "Cost by vendor", title: "Attributed to this client: its calls, texts, numbers, AI, speech, scrubs and its own fixed costs" },
  { key: null, label: "Shared (allocated)", title: "Fixed costs with no client, plus unmatched vendor usage when that is spread too" },
  { key: "costCents", label: "Cost" },
  { key: "marginCents", label: "Margin" },
  { key: "marginPct", label: "Margin %" },
];

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function PnlTable({ rows, floorPct, rule }: { rows: ClientPnlRow[]; floorPct: number; rule: "MINUTES" | "SEATS" }) {
  const [sort, setSort] = useState<{ key: PnlSortKey; dir: "asc" | "desc" }>({ key: "revenueCents", dir: "desc" });
  const sorted = sortPnl(rows, sort.key, sort.dir);
  const click = (key: PnlSortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            {COLS.map((c) => (
              <th key={c.label} className="px-3 py-2 font-medium" title={c.title}>
                {c.key ? (
                  <button type="button" onClick={() => click(c.key!)} className="inline-flex items-center gap-1 uppercase hover:text-zinc-300" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {c.label}
                    <span aria-hidden className="text-[10px]">
                      {sort.key === c.key ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                    </span>
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {sorted.map((r) => {
            const vendors = Object.entries(r.costByVendorCents)
              .filter(([, c]) => c !== 0)
              .sort((a, b) => b[1] - a[1]);
            return (
              <tr key={r.id} className={r.belowFloor ? "bg-red-950/30" : undefined}>
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  <div className="mt-0.5 flex gap-1">
                    {r.trial ? <Badge tone="blue">trial</Badge> : null}
                    {r.suspended ? <Badge tone="red">outbound paused</Badge> : null}
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums">{r.seats}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.minutes)}</td>
                <td className="px-3 py-2 tabular-nums">{r.numbers}</td>
                <td className="px-3 py-2 tabular-nums">{num(r.texts)}</td>
                <td className="px-3 py-2 tabular-nums">{money(r.revenueCents)}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">
                  {vendors.length === 0 ? "—" : vendors.map(([v, c]) => (
                    <div key={v} className="flex justify-between gap-3 tabular-nums">
                      <span className="capitalize">{v}</span>
                      <span>{money(c)}</span>
                    </div>
                  ))}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums text-zinc-400" title={`Fixed ${money(r.fixedAllocatedCents)} + unmatched usage ${money(r.unmatchedAllocatedCents)}, by ${rule === "SEATS" ? "seats" : "minutes"}`}>
                  {money(r.fixedAllocatedCents + r.unmatchedAllocatedCents)}
                </td>
                <td className="px-3 py-2 tabular-nums">{money(r.costCents)}</td>
                <td className={`px-3 py-2 tabular-nums ${r.marginCents < 0 ? "text-red-300" : "text-emerald-300"}`}>{money(r.marginCents)}</td>
                <td className={`px-3 py-2 font-semibold tabular-nums ${r.belowFloor ? "text-red-300" : "text-emerald-300"}`}>{r.marginPct === null ? "—" : `${r.marginPct}%`}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLS.length} className="px-3 py-4 text-zinc-500">
                No client workspaces yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-zinc-500">Red: margin under {floorPct}% (or a cost with no revenue). Click a heading to sort.</p>
    </div>
  );
}
