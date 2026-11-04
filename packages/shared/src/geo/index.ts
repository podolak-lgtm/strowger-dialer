// Where a lead is, for the calling window: ZIP first, area code second.
import { AREA_CODE_STATE, SPLIT_AREA_CODES, STATE_ZONE, STRADDLING_AREA_CODES, ZIP3_RANGES } from "./data";

export * from "./data";

export function stateForZip(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const m = /^\s*(\d{3})\d{2}/.exec(zip);
  if (!m) return null;
  const n = Number(m[1]);
  for (const [from, to, state] of ZIP3_RANGES) if (n >= from && n <= to) return state;
  return null;
}

export function stateForAreaCode(areaCode: string | null | undefined): string | null {
  return (areaCode && AREA_CODE_STATE[areaCode]) || null;
}

export type ZoneConfidence = "high" | "medium" | "low";

export interface ResolvedZone {
  timezone: string;
  state: string;
  /** Which input decided it. */
  basis: "zip" | "state" | "area_code";
  confidence: ZoneConfidence;
}

/**
 * Resolve a lead's zone.
 *  - ZIP gives the state (high confidence); the area code then only decides
 *    which side of a split state the lead is on.
 *  - A stated state without a usable ZIP is medium confidence.
 *  - Area code alone is medium, or low for codes that straddle a zone line.
 * Returns null when nothing usable is present; the engine refuses to dial an
 * unresolved lead rather than guess.
 */
export function resolveZone(input: {
  zip?: string | null;
  state?: string | null;
  phone?: string | null; // ten digits
}): ResolvedZone | null {
  const areaCode = input.phone && input.phone.length === 10 ? input.phone.slice(0, 3) : null;
  const zipState = stateForZip(input.zip);
  const givenState = input.state?.trim().toUpperCase() || null;
  const areaState = stateForAreaCode(areaCode);

  const state = zipState ?? (givenState && STATE_ZONE[givenState] ? givenState : null) ?? areaState;
  if (!state) return null;
  const basis: ResolvedZone["basis"] = zipState ? "zip" : givenState === state ? "state" : "area_code";

  let timezone = STATE_ZONE[state];
  if (!timezone) return null;
  let confidence: ZoneConfidence = basis === "zip" ? "high" : "medium";

  // Split-state resolution: only trust the area code's side of the line when
  // the area code belongs to the same state the lead is in.
  if (areaCode && areaState === state) {
    const override = SPLIT_AREA_CODES[areaCode];
    if (override) timezone = override;
    if (STRADDLING_AREA_CODES.has(areaCode)) confidence = basis === "zip" ? "medium" : "low";
  } else if (basis === "area_code" && areaCode && STRADDLING_AREA_CODES.has(areaCode)) {
    confidence = "low";
  }
  return { timezone, state, basis, confidence };
}
