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
import { FEDERAL_HOLIDAYS, type HolidayKey } from "./holidays";

export type DayOverride = { startHour: number; endHour: number } | null;

export interface StateRuleDef {
  state: string;
  startHour: number;
  endHour: number;
  dayOverrides?: Record<string, DayOverride>;
  maxAttemptsPerDay?: number;
  noHolidayCalls?: boolean;
  /** The holidays with no calls (holidays.ts); enforced by evaluateDialWindow. */
  holidays?: readonly HolidayKey[];
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
  // Rebuilt 7 Nov 2026 from a 50-state research pass (HANDOFF "State dialing rules"). Where sources conflict the
  // stricter reading is used; rules that the law applies only to unsolicited calls are applied to every call.
  { state: "AL", startHour: 8, endHour: 20, dayOverrides: { "0": null }, noHolidayCalls: true, holidays: [...FEDERAL_HOLIDAYS, "MARDI_GRAS", "CONFEDERATE_MEMORIAL", "JEFFERSON_DAVIS"], citation: "Ala. Admin. Code r. 770-X-5-.17 (PSC)" },
  { state: "CT", startHour: 9, endHour: 20, citation: "Conn. Gen. Stat. §42-288a" },
  { state: "FL", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Fla. Stat. §501.616(6); FTSA §501.059" },
  { state: "IL", startHour: 8, endHour: 21, citation: "815 ILCS 413/15" },
  { state: "IN", startHour: 8, endHour: 21, citation: "Ind. Code §24-4.7" },
  { state: "KY", startHour: 10, endHour: 21, citation: "KRS 367.46955" },
  {
    state: "LA",
    startHour: 8,
    endHour: 20,
    dayOverrides: { "0": null },
    noHolidayCalls: true,
    holidays: ["NEW_YEAR", "MLK", "MARDI_GRAS", "GOOD_FRIDAY", "MEMORIAL", "JUNETEENTH", "INDEPENDENCE", "LABOR", "ALL_SAINTS", "VETERANS", "ELECTION_DAY", "THANKSGIVING", "CHRISTMAS_EVE", "CHRISTMAS", "NEW_YEARS_EVE"],
    citation: "La. R.S. 45:844.12; LPSC General Order",
  },
  { state: "MA", startHour: 8, endHour: 20, citation: "M.G.L. c. 159C §3; 201 CMR 12.02" },
  { state: "MD", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Md. Com. Law §14-4502(c)" },
  { state: "MI", startHour: 9, endHour: 21, citation: "MCL 445.111c" },
  { state: "MN", startHour: 9, endHour: 21, citation: "Minn. Stat. §325E.27" },
  { state: "MS", startHour: 8, endHour: 20, dayOverrides: { "0": null }, citation: "Miss. Code §77-3-723" },
  { state: "ND", startHour: 8, endHour: 21, citation: "N.D.C.C. §51-28-05" },
  { state: "NJ", startHour: 8, endHour: 21, citation: "N.J.S.A. 56:8-128" },
  { state: "NM", startHour: 9, endHour: 21, citation: "NMSA 1978 §57-12-22" },
  { state: "NV", startHour: 9, endHour: 20, citation: "NRS 598.0918 (sources conflict; stricter reading)" },
  { state: "NY", startHour: 8, endHour: 21, citation: "N.Y. Gen. Bus. Law §399-z" },
  { state: "OK", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "Okla. Stat. tit. 15 §775C.4" },
  { state: "OR", startHour: 8, endHour: 20, maxAttemptsPerDay: 3, citation: "ORS 646A.372 (HB 3865, 2026)" },
  {
    state: "PA",
    startHour: 9,
    endHour: 19,
    // Act 47 of 2026: 9am-7pm, no Sundays or legal holidays. Saturday afternoon is a statutory half-holiday
    // (44 P.S. §11); blocked after noon until counsel says otherwise.
    dayOverrides: { "0": null, "6": { startHour: 9, endHour: 12 } },
    noHolidayCalls: true,
    holidays: [...FEDERAL_HOLIDAYS, "GOOD_FRIDAY", "FLAG_DAY", "ELECTION_DAY"],
    citation: "73 P.S. §2245 as amended by Act 47 of 2026",
  },
  {
    state: "RI",
    startHour: 9,
    endHour: 18,
    dayOverrides: { "0": null, "6": { startHour: 10, endHour: 17 } },
    noHolidayCalls: true,
    holidays: [...FEDERAL_HOLIDAYS, "RI_INDEPENDENCE", "VICTORY_DAY", "ELECTION_DAY"],
    citation: "R.I. Gen. Laws §5-61-3.4",
  },
  { state: "SC", startHour: 8, endHour: 21, citation: "S.C. Code §37-21-30" },
  {
    state: "TX",
    startHour: 9,
    endHour: 21,
    dayOverrides: { "0": { startHour: 12, endHour: 21 } },
    citation: "Tex. Bus. & Com. Code §301.051",
  },
  {
    state: "UT",
    startHour: 8,
    endHour: 21,
    dayOverrides: { "0": null },
    noHolidayCalls: true,
    holidays: [...FEDERAL_HOLIDAYS, "PIONEER_DAY"],
    citation: "Utah Code §13-25a-103",
  },
  { state: "WA", startHour: 8, endHour: 20, citation: "RCW 80.36.390" },
  { state: "WY", startHour: 8, endHour: 20, citation: "Wyo. Stat. §40-12-302" },
];

export function ruleForState(state: string | null | undefined): StateRuleDef | undefined {
  if (!state) return undefined;
  const s = state.toUpperCase();
  return STATE_RULES.find((r) => r.state === s);
}
