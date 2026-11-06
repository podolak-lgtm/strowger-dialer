// Number planning (owner, 6 Nov): from the leads a campaign (or one list) has
// to dial, work out how many caller-ID numbers each area code needs, what the
// campaign already has, what the workspace's shared pool can lend, and what is
// left to order from Telnyx. Pure: the engine loads the counts and numbers and
// applies the result. Assumptions are data here (PLAN_DEFAULTS) so the page
// can print them and a change comes with a test.
import { DID_RULES } from "./did-hygiene";

export const PLAN_DEFAULTS = {
  /**
   * Dials per lead on the day it is worked: the campaign's attempt rule
   * (max of maxAttemptsPerDay, dial plan attemptsPerDay, list cadence),
   * capped at 3 because few leads use every allowed attempt.
   */
  maxDialsPerLeadPerDay: 3,
  /** Working days a week. */
  workDaysPerWeek: 5,
  /** A list is worked over one week unless the caller says otherwise: leads per day = leads / days. */
  listDays: 5,
  /** Dials a day per established number (DID_RULES.establishedCap). */
  numberCap: DID_RULES.establishedCap,
  /**
   * Warm-up allowance: a new number does 40 a day in week one and 65 in weeks
   * two and three, so numbers to order are sized at the weeks 2–3 cap (65):
   * a shortfall of n orders round(n × 75 / 65), at least n. The spare absorbs week one.
   */
  newNumberCap: DID_RULES.warmup[1]!.cap,
  /** Spares for rotation and rest, per area code (rounded); at least one in the plan. */
  spareFactor: 0.2,
  minSpare: 1,
  /** Below this many leads a week an area code shares the busiest area code of its state. */
  minLeadsPerAreaCode: 25,
  /** Pool numbers unused this long are worth returning to Telnyx. */
  idleDays: 14,
} as const;

export interface PlanOptions {
  /** Take matching pool numbers before ordering (default true). */
  poolFirst?: boolean;
  /** Only numbers in the exact area code count; otherwise same-state pool numbers may stand in. */
  exactOnly?: boolean;
}

export interface PlanLeads {
  areaCode: string;
  /** State of the area code (stateForAreaCode); null when unknown. */
  state: string | null;
  leads: number;
}

export interface PlanNumber {
  id: string;
  phone: string;
  areaCode: string;
  state: string | null;
}

export interface PlanInput extends PlanOptions {
  leads: PlanLeads[];
  /** Numbers pinned to this campaign that can dial: ACTIVE, not resting, not failed or released. */
  have: PlanNumber[];
  /** Shared pool numbers (no campaign) that can dial: ACTIVE, not resting. */
  pool: PlanNumber[];
  /** The campaign's attempt rule before the realistic cap. */
  attemptRule: number;
  /** Days the leads are spread over (default PLAN_DEFAULTS.listDays). */
  listDays?: number;
  /** What one number costs the customer per month, in cents. */
  priceCents: number;
}

export interface PlanRow {
  areaCode: string;
  state: string | null;
  leads: number;
  /** Small area codes of the same state folded into this row. */
  folded: string[];
  dailyDials: number;
  needed: number;
  have: number;
  /** Pool numbers that could serve this row (same area code; same state too unless exactOnly). */
  poolCandidates: number;
  /** Taken from the pool for this row, same area code and stand-ins from the same state. */
  takeExact: number;
  takeState: number;
  toOrder: number;
}

export interface DidPlan {
  rows: PlanRow[];
  /** Pool numbers to pin to the campaign, with the row each serves. */
  take: { id: string; phone: string; forAreaCode: string; sameAreaCode: boolean }[];
  /** What to order from Telnyx, by area code. */
  order: { areaCode: string; state: string | null; count: number }[];
  totals: { leads: number; dailyDials: number; needed: number; have: number; take: number; order: number; surplus: number };
  /** Monthly cost of the numbers to order, and of every number the campaign holds once the plan is applied. */
  monthlyOrderCents: number;
  monthlyAllCents: number;
  priceCents: number;
  assumptions: { dialsPerLeadPerDay: number; listDays: number; numberCap: number; newNumberCap: number; spareFactor: number; minSpare: number; minLeadsPerAreaCode: number; poolFirst: boolean; exactOnly: boolean };
}

/** Dials per lead per day the plan assumes: the attempt rule, at most 3, at least 1. */
export function dialsPerLead(rule: number): number {
  return Math.max(1, Math.min(PLAN_DEFAULTS.maxDialsPerLeadPerDay, Math.floor(rule) || 1));
}

/**
 * Area codes with fewer than `min` leads fold into the busiest area code of
 * the same state (which keeps the row even if it is small itself). Area codes
 * with no known state keep their own row.
 */
export function foldAreaCodes(leads: PlanLeads[], min: number = PLAN_DEFAULTS.minLeadsPerAreaCode): { areaCode: string; state: string | null; leads: number; folded: string[] }[] {
  const merged = new Map<string, PlanLeads>();
  for (const l of leads) {
    if (l.leads <= 0) continue;
    const m = merged.get(l.areaCode);
    if (m) m.leads += l.leads;
    else merged.set(l.areaCode, { ...l });
  }
  const sorted = [...merged.values()].sort((a, b) => b.leads - a.leads || a.areaCode.localeCompare(b.areaCode));
  const host = new Map<string, string>();
  for (const l of sorted) if (l.state && !host.has(l.state)) host.set(l.state, l.areaCode);
  const rows = new Map<string, { areaCode: string; state: string | null; leads: number; folded: string[] }>();
  for (const l of sorted) {
    const into = l.leads < min && l.state ? host.get(l.state)! : l.areaCode;
    const row = rows.get(into) ?? { areaCode: into, state: l.state, leads: 0, folded: [] };
    row.leads += l.leads;
    if (into !== l.areaCode) row.folded.push(l.areaCode);
    rows.set(into, row);
  }
  return [...rows.values()].sort((a, b) => b.leads - a.leads || a.areaCode.localeCompare(b.areaCode));
}

export function planDids(input: PlanInput): DidPlan {
  const poolFirst = input.poolFirst ?? true;
  const exactOnly = input.exactOnly ?? false;
  const perLead = dialsPerLead(input.attemptRule);
  const listDays = Math.max(1, input.listDays ?? PLAN_DEFAULTS.listDays);
  const cap = PLAN_DEFAULTS.numberCap;

  const folded = foldAreaCodes(input.leads);
  const haveBy = groupCount(input.have);
  const rows: PlanRow[] = folded.map((f) => {
    const dailyDials = Math.ceil((f.leads / listDays) * perLead);
    const base = Math.ceil(dailyDials / cap);
    const needed = base + Math.round(base * PLAN_DEFAULTS.spareFactor);
    return { areaCode: f.areaCode, state: f.state, leads: f.leads, folded: f.folded, dailyDials, needed, have: haveBy.get(f.areaCode) ?? 0, poolCandidates: 0, takeExact: 0, takeState: 0, toOrder: 0 };
  });
  // At least one spare across the plan, on the busiest row.
  const spares = rows.reduce((n, r) => n + (r.needed - Math.ceil(r.dailyDials / cap)), 0);
  if (rows.length && spares < PLAN_DEFAULTS.minSpare) rows[0]!.needed += PLAN_DEFAULTS.minSpare - spares;

  // Pinned numbers in area codes the plan does not need stay where they are.
  const planned = new Set(rows.map((r) => r.areaCode));
  const surplus = input.have.filter((n) => !planned.has(n.areaCode)).length;

  // Pool: exact area code first for every row, then same-state stand-ins.
  const free = [...input.pool].sort((a, b) => a.phone.localeCompare(b.phone));
  const used = new Set<string>();
  const take: DidPlan["take"] = [];
  for (const r of rows) r.poolCandidates = free.filter((n) => n.areaCode === r.areaCode || (!exactOnly && r.state && n.state === r.state)).length;
  if (poolFirst) {
    for (const r of rows) {
      let short = Math.max(0, r.needed - r.have);
      for (const n of free) {
        if (short === 0) break;
        if (used.has(n.id) || n.areaCode !== r.areaCode) continue;
        used.add(n.id);
        take.push({ id: n.id, phone: n.phone, forAreaCode: r.areaCode, sameAreaCode: true });
        r.takeExact++;
        short--;
      }
    }
    if (!exactOnly) {
      for (const r of rows) {
        let short = Math.max(0, r.needed - r.have - r.takeExact);
        for (const n of free) {
          if (short === 0 || !r.state) break;
          if (used.has(n.id) || n.state !== r.state) continue;
          used.add(n.id);
          take.push({ id: n.id, phone: n.phone, forAreaCode: r.areaCode, sameAreaCode: false });
          r.takeState++;
          short--;
        }
      }
    }
  }

  // What is still short is ordered, sized at the warm-up cap (rounded, never fewer than the shortfall).
  const order: DidPlan["order"] = [];
  for (const r of rows) {
    const short = Math.max(0, r.needed - r.have - r.takeExact - r.takeState);
    r.toOrder = short === 0 ? 0 : Math.max(short, Math.round((short * cap) / PLAN_DEFAULTS.newNumberCap));
    if (r.toOrder > 0) order.push({ areaCode: r.areaCode, state: r.state, count: r.toOrder });
  }

  const sum = (f: (r: PlanRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const totals = { leads: sum((r) => r.leads), dailyDials: sum((r) => r.dailyDials), needed: sum((r) => r.needed), have: sum((r) => r.have), take: take.length, order: sum((r) => r.toOrder), surplus };
  return {
    rows,
    take,
    order,
    totals,
    monthlyOrderCents: totals.order * input.priceCents,
    monthlyAllCents: (input.have.length + take.length + totals.order) * input.priceCents,
    priceCents: input.priceCents,
    assumptions: {
      dialsPerLeadPerDay: perLead,
      listDays,
      numberCap: cap,
      newNumberCap: PLAN_DEFAULTS.newNumberCap,
      spareFactor: PLAN_DEFAULTS.spareFactor,
      minSpare: PLAN_DEFAULTS.minSpare,
      minLeadsPerAreaCode: PLAN_DEFAULTS.minLeadsPerAreaCode,
      poolFirst,
      exactOnly,
    },
  };
}

function groupCount(ns: PlanNumber[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of ns) m.set(n.areaCode, (m.get(n.areaCode) ?? 0) + 1);
  return m;
}

/** A pool number worth talking about returning: no use in `idleDays` (or never used and that old). */
export function isIdlePoolNumber(n: { campaignId: string | null; status: string; lastUsedAt: Date | null; createdAt: Date }, now = new Date(), idleDays: number = PLAN_DEFAULTS.idleDays): boolean {
  if (n.campaignId !== null || n.status === "RETIRED") return false;
  const cutoff = now.getTime() - idleDays * 86_400_000;
  return (n.lastUsedAt ?? n.createdAt).getTime() < cutoff;
}

export type CallerIdFallbackMode = "ANY" | "SAME_STATE" | "EXACT_ONLY";

/**
 * Where local presence looks once no number with the lead's area code is
 * free: any area code, the lead's state only, or nowhere (the campaign's
 * fixed caller ID if set, else the lead waits).
 */
export function callerIdFallbackScope(mode: CallerIdFallbackMode, leadState: string | null): { kind: "any" } | { kind: "state"; state: string } | { kind: "none" } {
  if (mode === "ANY") return { kind: "any" };
  if (mode === "SAME_STATE" && leadState) return { kind: "state", state: leadState };
  return { kind: "none" };
}
