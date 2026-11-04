/**
 * State calling-time and attempt rules.
 *
 * STARTING MATRIX, TO BE VERIFIED BY COUNSEL BEFORE GO-LIVE. Several states
 * changed these in 2023–2025 and they keep moving. The seed writes these rows
 * with verifiedAt null; the admin screen shows an unverified rule as such.
 *
 * Hours are the lead's local time, 24h; endHour is exclusive (endHour 21 means
 * no dial at or after 21:00). dayOverrides keys are JS weekday numbers
 * (0 = Sunday); a null value means no calls that day.
 */
export type DayOverride = { startHour: number; endHour: number } | null;

export interface StateRuleDef {
  state: string;
  startHour: number;
  endHour: number;
  dayOverrides?: Record<string, DayOverride>;
  maxAttemptsPerDay?: number;
  noHolidayCalls?: boolean;
  citation?: string;
}

/** Federal baseline (Telemarketing Sales Rule, 16 CFR 310.4(c)). */
export const FEDERAL_RULE: StateRuleDef = {
  state: "US",
  startHour: 8,
  endHour: 21,
  citation: "16 CFR 310.4(c)",
};

export const STATE_RULES: StateRuleDef[] = [
  { state: "FL", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Fla. Stat. 501.059 (FTSA)" },
  { state: "OK", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Okla. Stat. tit. 15 §775C" },
  { state: "WA", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "RCW 80.36.390 / 19.158" },
  { state: "MD", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Md. Com. Law §14-4601 (Stop the Call)" },
  { state: "CT", startHour: 9, endHour: 20, maxAttemptsPerDay: 3, citation: "Conn. Gen. Stat. §42-288a" },
  { state: "NJ", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "N.J.S.A. 56:8-128 et seq." },
  {
    state: "TX",
    startHour: 9,
    endHour: 21,
    dayOverrides: { "0": { startHour: 12, endHour: 21 } },
    citation: "Tex. Bus. & Com. Code §301.051",
  },
  { state: "MS", startHour: 8, endHour: 21, dayOverrides: { "0": null }, citation: "Miss. Code §77-3-707" },
  {
    state: "RI",
    startHour: 9,
    endHour: 18,
    dayOverrides: { "0": null, "6": { startHour: 10, endHour: 17 } },
    citation: "R.I. Gen. Laws §5-61-3.4",
  },
  { state: "LA", startHour: 8, endHour: 20, dayOverrides: { "0": null }, noHolidayCalls: true, citation: "La. R.S. 45:844.12" },
  { state: "SC", startHour: 8, endHour: 21, citation: "S.C. Code §16-17-446" },
  { state: "AL", startHour: 8, endHour: 20, citation: "Ala. Code §8-19A-14" },
  { state: "UT", startHour: 8, endHour: 21, citation: "Utah Code §13-25a-103" },
  { state: "NY", startHour: 8, endHour: 21, citation: "N.Y. Gen. Bus. Law §399-z" },
  { state: "PA", startHour: 8, endHour: 21, citation: "73 P.S. §2245" },
  { state: "KY", startHour: 10, endHour: 21, citation: "KRS 367.46955" },
  { state: "NV", startHour: 8, endHour: 21, citation: "NRS 599B" },
  { state: "ND", startHour: 9, endHour: 21, citation: "N.D.C.C. §51-28-02" },
  { state: "IN", startHour: 8, endHour: 21, citation: "Ind. Code §24-4.7" },
];

export function ruleForState(state: string | null | undefined): StateRuleDef | undefined {
  if (!state) return undefined;
  const s = state.toUpperCase();
  return STATE_RULES.find((r) => r.state === s);
}
