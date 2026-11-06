// Platform accounting (owner, 6 Nov: "I'd like to know by client if we're
// profitable and that our margins are good"). Pure maths only: the engine
// gathers revenue (BillingEntry charges) and cost (VendorUsage) per client and
// month, and this turns them into a P&L per client with shared costs spread by
// one stated rule. Money in is cents; costs are summed in millicents (1/1000 ¢)
// so per-request AI costs of a fraction of a cent are not lost, and rounded to
// the cent once per client.

export type CostAllocation = "MINUTES" | "SEATS";
export const COST_ALLOCATIONS: readonly CostAllocation[] = ["MINUTES", "SEATS"];
export const DEFAULT_MARGIN_FLOOR_PCT = 40;

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod = (p: unknown): p is string => typeof p === "string" && PERIOD.test(p);

/** The month before a YYYY-MM period. */
export function prevPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function nextPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The months a fixed cost covers, up to and including `upTo` (never the future). */
export function periodsCovered(cost: { cadence: string; startPeriod: string; endPeriod?: string | null }, upTo: string): string[] {
  if (!isPeriod(cost.startPeriod) || !isPeriod(upTo) || cost.startPeriod > upTo) return [];
  if (cost.cadence === "ONCE") return [cost.startPeriod];
  const last = cost.endPeriod && isPeriod(cost.endPeriod) && cost.endPeriod < upTo ? cost.endPeriod : upTo;
  const out: string[] = [];
  for (let p = cost.startPeriod; p <= last && out.length < 600; p = nextPeriod(p)) out.push(p);
  return out;
}

/**
 * Split `total` across ids in proportion to their weights, in whole units, so
 * the parts add up to the total exactly (largest remainder; ties to the
 * earlier id). Ids with no weight get nothing; all weights zero = nothing is
 * allocated (the caller shows it as unallocated rather than inventing a split).
 */
export function allocate(total: number, weights: ReadonlyArray<{ id: string; weight: number }>): Map<string, number> {
  const out = new Map<string, number>();
  const live = weights.filter((w) => Number.isFinite(w.weight) && w.weight > 0);
  const sum = live.reduce((n, w) => n + w.weight, 0);
  if (!(total > 0) || sum <= 0) return out;
  const whole = Math.round(total);
  const parts = live.map((w, i) => {
    const exact = (whole * w.weight) / sum;
    return { id: w.id, i, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = whole - parts.reduce((n, p) => n + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i)) {
    if (left <= 0) break;
    p.base += 1;
    left -= 1;
  }
  for (const p of parts) out.set(p.id, (out.get(p.id) ?? 0) + p.base);
  return out;
}

/** Margin and margin %; the % is null when there is no revenue (a cost with no revenue is a loss, not a percentage). */
export function marginOf(revenueCents: number, costCents: number): { marginCents: number; marginPct: number | null } {
  const marginCents = revenueCents - costCents;
  return { marginCents, marginPct: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : null };
}

/** Under the floor, or losing money with no revenue at all. */
export function belowFloor(m: { marginCents: number; marginPct: number | null }, floorPct: number): boolean {
  return m.marginPct === null ? m.marginCents < 0 : m.marginPct < floorPct;
}

export interface ClientInput {
  id: string;
  name: string;
  seats: number;
  minutes: number;
  numbers: number;
  texts: number;
  revenueCents: number;
  /** Cost attributed to this client directly, by vendor, in millicents. */
  costByVendorMillicents: Record<string, number>;
}

export interface ClientPnl extends ClientInput {
  costByVendorCents: Record<string, number>;
  attributedCents: number;
  fixedAllocatedCents: number;
  unmatchedAllocatedCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  belowFloor: boolean;
}

export interface PnlInput {
  clients: ClientInput[];
  /** Fixed monthly costs with no client (Railway, Clerk, the jambonz plan…), millicents. */
  sharedFixedMillicents: number;
  /** Vendor usage that matched no client (AMD, conference legs, unmatched records), millicents. */
  unattributedMillicents: number;
  rule: CostAllocation;
  allocateUnattributed: boolean;
  floorPct: number;
}

export interface Pnl {
  rule: CostAllocation;
  rows: ClientPnl[];
  /** Shared cost no client carried (no client had any minutes / seats, or unmatched usage not spread), millicents. */
  unallocatedMillicents: number;
  totals: { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null };
}

export const weightOf = (c: Pick<ClientInput, "minutes" | "seats">, rule: CostAllocation): number => (rule === "SEATS" ? c.seats : c.minutes);

export function buildPnl(input: PnlInput): Pnl {
  const weights = input.clients.map((c) => ({ id: c.id, weight: weightOf(c, input.rule) }));
  const fixed = allocate(input.sharedFixedMillicents, weights);
  const unmatched = input.allocateUnattributed ? allocate(input.unattributedMillicents, weights) : new Map<string, number>();
  const sumOf = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);
  const unallocatedMillicents = Math.max(0, Math.round(input.sharedFixedMillicents) - sumOf(fixed)) + Math.max(0, Math.round(input.unattributedMillicents) - sumOf(unmatched));
  const rows = input.clients.map((c): ClientPnl => {
    const costByVendorCents = Object.fromEntries(Object.entries(c.costByVendorMillicents).map(([v, mc]) => [v, Math.round(mc / 1000)]));
    const attributedMc = Object.values(c.costByVendorMillicents).reduce((n, v) => n + v, 0);
    const fixedMc = fixed.get(c.id) ?? 0;
    const unmatchedMc = unmatched.get(c.id) ?? 0;
    const costCents = Math.round((attributedMc + fixedMc + unmatchedMc) / 1000);
    const m = marginOf(c.revenueCents, costCents);
    return {
      ...c,
      costByVendorCents,
      attributedCents: Math.round(attributedMc / 1000),
      fixedAllocatedCents: Math.round(fixedMc / 1000),
      unmatchedAllocatedCents: Math.round(unmatchedMc / 1000),
      costCents,
      ...m,
      belowFloor: belowFloor(m, input.floorPct),
    };
  });
  const revenueCents = rows.reduce((n, r) => n + r.revenueCents, 0);
  const costCents = rows.reduce((n, r) => n + r.costCents, 0);
  return { rule: input.rule, rows, unallocatedMillicents, totals: { revenueCents, costCents, ...marginOf(revenueCents, costCents) } };
}

export type PnlSortKey = "name" | "seats" | "minutes" | "numbers" | "texts" | "revenueCents" | "costCents" | "marginCents" | "marginPct";

/** Sort a copy; a null margin % sorts below every number either way. */
export function sortPnl<T extends Pick<ClientPnl, PnlSortKey>>(rows: readonly T[], key: PnlSortKey, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    if (typeof x === "string" && typeof y === "string") return sign * x.localeCompare(y);
    return sign * ((x as number) - (y as number));
  });
}

/** A vendor balance at or under its warning line. */
export const balanceLow = (balanceCents: number | null | undefined, lowCents: number | null | undefined): boolean => balanceCents !== null && balanceCents !== undefined && lowCents !== null && lowCents !== undefined && balanceCents <= lowCents;

/** RFC 4180 CSV: quote fields with a comma, quote or newline; a leading =, +, - or @ is prefixed so a spreadsheet does not run it. */
export function toCsv(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Characters a jambonz verb list will speak (top-level `say` and the `say` nested in a `gather`). */
export function spokenChars(verbs: unknown): number {
  if (!Array.isArray(verbs)) return 0;
  let n = 0;
  const text = (t: unknown) => (typeof t === "string" ? t.length : Array.isArray(t) ? t.reduce((k: number, x) => k + (typeof x === "string" ? x.length : 0), 0) : 0);
  for (const v of verbs) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (o.verb === "say") n += text(o.text);
    const nested = o.say as Record<string, unknown> | undefined;
    if (o.verb === "gather" && nested && typeof nested === "object") n += text(nested.text);
  }
  return n;
}
