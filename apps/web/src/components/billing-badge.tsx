// The prepaid balance, visible on every screen for the people who can act on
// it (owner, 5 Nov: "make it very obvious if their balance gets low; they
// don't want to get turned off in a day").
import Link from "next/link";
import type { BillingStatus } from "@/lib/billing-actions";

export const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BillingBadge({ b, compact = false }: { b: BillingStatus | null; compact?: boolean }) {
  if (!b || b.isPlatform) return null;
  const tone = b.suspended || b.critical ? "border-red-500/50 bg-red-950/60 text-red-200" : b.low ? "border-amber-500/50 bg-amber-950/60 text-amber-200" : "border-zinc-700 bg-zinc-900 text-zinc-300";
  const line = b.suspended
    ? "Outbound paused: balance used up"
    : b.critical
      ? `Balance exhausted · outbound pauses in ${b.graceDays} day${b.graceDays === 1 ? "" : "s"}`
      : b.low
        ? `Low balance${b.runwayDays !== null ? ` · about ${b.runwayDays} day${b.runwayDays === 1 ? "" : "s"} left` : ""}`
        : b.runwayDays !== null
          ? `about ${b.runwayDays} days at current use`
          : "prepaid";
  return (
    <Link href="/billing" className={`block rounded-md border px-3 py-2 text-xs ${tone} ${compact ? "" : "mt-3"}`} title="Billing">
      <div className="flex items-center justify-between gap-2">
        <span className="uppercase tracking-wide opacity-70">Balance</span>
        <span className="text-sm font-semibold tabular-nums">{money(b.balanceCents)}</span>
      </div>
      <div className="mt-0.5 truncate">{line}</div>
    </Link>
  );
}
