"use client";

// Idle pool numbers (owner, 6 Nov): ticked numbers are released to Telnyx
// after a confirm. Nothing is ever released by itself.
import { formatPhone } from "@strowger/shared/phone";
import { useState } from "react";
import { releaseIdle } from "./plan-actions";

export interface IdleNumber {
  id: string;
  phone: string;
  status: string;
  /** "never used" or the last-used day, YYYY-MM-DD. */
  lastUsed: string;
  idleDays: number;
  releasable: boolean;
}

export function IdleRelease({ numbers, priceCents }: { numbers: IdleNumber[]; priceCents: number }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const releasable = numbers.filter((n) => n.releasable);
  return (
    <form
      action={releaseIdle}
      onSubmit={(e) => {
        if (!window.confirm(`Release ${picked.size} number${picked.size === 1 ? "" : "s"} back to Telnyx? They leave the account for good (saves ${money(picked.size * priceCents)} a month). This cannot be undone.`)) e.preventDefault();
      }}
      className="space-y-3 text-sm"
    >
      <div className="overflow-x-auto rounded-md border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="bg-zinc-900 text-left uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-2 py-1.5">
                <input type="checkbox" aria-label="Pick all" className="h-4 w-4" checked={releasable.length > 0 && picked.size === releasable.length} onChange={(e) => setPicked(e.target.checked ? new Set(releasable.map((n) => n.id)) : new Set())} />
              </th>
              <th className="px-2 py-1.5 font-medium">Number</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Last used</th>
              <th className="px-2 py-1.5 font-medium">Idle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 tabular-nums">
            {numbers.map((n) => (
              <tr key={n.id}>
                <td className="px-2 py-1.5">
                  {n.releasable ? <input type="checkbox" name="ids" value={n.id} className="h-4 w-4" checked={picked.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} /> : <span title="Not a Telnyx number; remove it on Settings">–</span>}
                </td>
                <td className="px-2 py-1.5 font-mono">{formatPhone(n.phone)}</td>
                <td className="px-2 py-1.5 text-zinc-400">{n.status.toLowerCase().replace("_", " ")}</td>
                <td className="px-2 py-1.5 text-zinc-400">{n.lastUsed}</td>
                <td className="px-2 py-1.5">{n.idleDays} days</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={picked.size === 0} className="rounded-md border border-red-900 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-950 disabled:opacity-50">
          Release selected to Telnyx{picked.size ? ` (${picked.size})` : ""}
        </button>
        <span className="text-xs text-zinc-500">
          {numbers.length} idle · {money(numbers.length * priceCents)} a month at {money(priceCents)} each
        </span>
      </div>
    </form>
  );
}
