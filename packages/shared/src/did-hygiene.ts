// Caller-ID (DID) hygiene rules, as data. Carrier analytics (Hiya, First
// Orion, TNS) score volume, short calls, answer rate and complaints; these
// defaults keep a number under the thresholds dialer shops see in practice.

export const DID_RULES = {
  /** Dials per day by number age (days since first dial). */
  warmup: [
    { maxAgeDays: 7, cap: 40 }, // week 1: 20–50
    { maxAgeDays: 21, cap: 65 }, // weeks 2–3: 50–75
  ],
  establishedCap: 75,
  /** Hours a day's dials are spread across for the per-hour ceiling. */
  spreadHours: 10,
  /** A call shorter than this many seconds counts against the number. */
  shortCallSeconds: 10,
  /** Rest after a spam flag before the number may dial again. */
  restAfterFlagDays: 21,
  /** Require Free Caller Registry registration before the first dial. */
  requireRegistration: true,
} as const;

export function capForNumber(n: { dailyCap: number | null; firstUsedAt: Date | null }, now = new Date()): number {
  if (n.dailyCap && n.dailyCap > 0) return n.dailyCap;
  if (!n.firstUsedAt) return DID_RULES.warmup[0]!.cap;
  const age = (now.getTime() - n.firstUsedAt.getTime()) / 86_400_000;
  for (const w of DID_RULES.warmup) if (age < w.maxAgeDays) return w.cap;
  return DID_RULES.establishedCap;
}

export function hourlyCap(dailyCap: number): number {
  return Math.max(1, Math.ceil(dailyCap / DID_RULES.spreadHours));
}

export function warmupStage(n: { firstUsedAt: Date | null }, now = new Date()): "new" | "week 1" | "weeks 2–3" | "established" {
  if (!n.firstUsedAt) return "new";
  const age = (now.getTime() - n.firstUsedAt.getTime()) / 86_400_000;
  return age < 7 ? "week 1" : age < 21 ? "weeks 2–3" : "established";
}

/** How many numbers a daily dial volume needs at the established cap. */
export function numbersNeeded(dialsPerDay: number, cap = DID_RULES.establishedCap): number {
  return Math.ceil(dialsPerDay / cap);
}
