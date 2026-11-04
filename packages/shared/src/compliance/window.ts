/**
 * Decides whether one phone may be dialed right now. Rules are data; the most
 * restrictive wins; every refusal names the rule that caused it.
 */
import { FEDERAL_RULE, ruleForState, type StateRuleDef } from "./state-rules";

export interface DialWindowInput {
  /** IANA zone for the lead. Null = unknown; the engine refuses unknown zones. */
  timezone: string | null;
  /** Two-letter state, when known. */
  state: string | null;
  /** Campaign window, local hours, end exclusive. */
  campaignStartHour: number;
  campaignEndHour: number;
  /** Campaign or dial-plan attempts allowed per day. */
  attemptsAllowedPerDay: number;
  /** Attempts already made to this phone in this campaign today (lead-local day). */
  attemptsToday: number;
  /** Extra rules a tenant has layered on (e.g. a verified override). */
  extraRules?: StateRuleDef[];
  now?: Date;
}

export type DialDecision =
  | { allowed: true; localHour: number; localWeekday: number }
  | { allowed: false; reason: string; rule: string; localHour?: number };

interface LocalTime {
  hour: number;
  weekday: number; // 0 = Sunday
}

export function localTimeIn(zone: string, at: Date): LocalTime | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(at);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    const dayPart = parts.find((p) => p.type === "weekday")?.value;
    if (hourPart === undefined || dayPart === undefined) return null;
    const hour = Number(hourPart) % 24;
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayPart);
    if (weekday < 0 || Number.isNaN(hour)) return null;
    return { hour, weekday };
  } catch {
    return null;
  }
}

function effectiveHours(rule: StateRuleDef, weekday: number): { start: number; end: number } | null {
  const override = rule.dayOverrides?.[String(weekday)];
  if (override === null) return null;
  if (override) return { start: override.startHour, end: override.endHour };
  return { start: rule.startHour, end: rule.endHour };
}

export function evaluateDialWindow(input: DialWindowInput): DialDecision {
  const now = input.now ?? new Date();
  if (!input.timezone) {
    return { allowed: false, reason: "Lead time zone unknown", rule: "timezone" };
  }
  const local = localTimeIn(input.timezone, now);
  if (!local) {
    return { allowed: false, reason: `Unrecognised time zone ${input.timezone}`, rule: "timezone" };
  }

  const rules: StateRuleDef[] = [FEDERAL_RULE];
  const stateRule = ruleForState(input.state);
  if (stateRule) rules.push(stateRule);
  if (input.extraRules) rules.push(...input.extraRules);

  // Narrowest window across every rule.
  let start = input.campaignStartHour;
  let end = input.campaignEndHour;
  let attemptsCap = input.attemptsAllowedPerDay;
  for (const rule of rules) {
    const hours = effectiveHours(rule, local.weekday);
    if (!hours) {
      return {
        allowed: false,
        reason: `No calls on this weekday in ${rule.state}`,
        rule: rule.citation ?? rule.state,
        localHour: local.hour,
      };
    }
    start = Math.max(start, hours.start);
    end = Math.min(end, hours.end);
    if (rule.maxAttemptsPerDay !== undefined) {
      attemptsCap = Math.min(attemptsCap, rule.maxAttemptsPerDay);
    }
  }

  if (local.hour < start || local.hour >= end) {
    return {
      allowed: false,
      reason: `Outside calling window ${start}:00–${end}:00 local`,
      rule: stateRule ? (stateRule.citation ?? stateRule.state) : "campaign/federal window",
      localHour: local.hour,
    };
  }
  if (input.attemptsToday >= attemptsCap) {
    return {
      allowed: false,
      reason: `Attempt cap reached (${attemptsCap}/day)`,
      rule: stateRule?.maxAttemptsPerDay !== undefined && stateRule.maxAttemptsPerDay <= attemptsCap
        ? (stateRule.citation ?? stateRule.state)
        : "campaign attempts",
      localHour: local.hour,
    };
  }
  return { allowed: true, localHour: local.hour, localWeekday: local.weekday };
}
