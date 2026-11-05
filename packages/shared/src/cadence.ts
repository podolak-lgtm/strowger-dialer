// Cadence math: dayparts in the lead's local time, the next slot that
// honours rotation and the minimum gap, and template rendering for texts.

export type Daypart = "MORNING" | "AFTERNOON" | "EVENING";
export const DAYPARTS: Daypart[] = ["MORNING", "AFTERNOON", "EVENING"];

/** Local hours, fractional: 8.5 = 08:30. End is exclusive. */
export type DaypartWindows = Record<Daypart, [number, number]>;

export const DEFAULT_DAYPARTS: DaypartWindows = {
  MORNING: [8.5, 11.5],
  AFTERNOON: [12.5, 16.5],
  EVENING: [17, 19.5],
};

export function parseDayparts(raw: unknown): DaypartWindows {
  const out: DaypartWindows = { ...DEFAULT_DAYPARTS };
  if (raw && typeof raw === "object") {
    for (const d of DAYPARTS) {
      const v = (raw as Record<string, unknown>)[d];
      if (Array.isArray(v) && v.length === 2) {
        const [a, b] = v as unknown[];
        if (typeof a === "number" && typeof b === "number" && a < b) out[d] = [a, b];
      }
    }
  }
  return out;
}

/** Local wall-clock parts for a zone. */
export function localParts(zone: string, at: Date): { hourFrac: number; y: number; m: number; d: number; weekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    }).formatToParts(at);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = Number(g("hour")) % 24;
    const minute = Number(g("minute"));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
    if ([hour, minute].some(Number.isNaN) || weekday < 0) return null;
    return { hourFrac: hour + minute / 60, y: Number(g("year")), m: Number(g("month")), d: Number(g("day")), weekday };
  } catch {
    return null;
  }
}

/** Which daypart a local hour falls in, or null between windows. */
export function daypartOf(hourFrac: number, windows: DaypartWindows = DEFAULT_DAYPARTS): Daypart | null {
  for (const d of DAYPARTS) {
    const [a, b] = windows[d];
    if (hourFrac >= a && hourFrac < b) return d;
  }
  return null;
}

/** The UTC offset of a zone at an instant, in minutes (east positive). */
function offsetMinutes(zone: string, at: Date): number {
  const p = localParts(zone, at);
  if (!p) return 0;
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.hourFrac), Math.round((p.hourFrac % 1) * 60));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant of a local wall-clock hour on the lead's local calendar day of `at` (+dayOffset). */
export function instantAtLocal(zone: string, at: Date, hourFrac: number, dayOffset = 0): Date {
  const p = localParts(zone, at);
  if (!p) return new Date(at.getTime() + dayOffset * 86_400_000);
  const guess = Date.UTC(p.y, p.m - 1, p.d + dayOffset, Math.floor(hourFrac), Math.round((hourFrac % 1) * 60));
  // Correct for the zone offset at the target instant (handles DST edges well enough).
  const off = offsetMinutes(zone, new Date(guess));
  return new Date(guess - off * 60_000);
}

export interface NextAttemptInput {
  zone: string;
  now: Date;
  lastAttemptAt: Date | null;
  lastDaypart: Daypart | null;
  minGapMinutes: number;
  rotateDayparts: boolean;
  windows?: DaypartWindows;
}

/**
 * Earliest instant for the next attempt: after the minimum gap, and (when
 * rotating) at the start of the next daypart window that differs from the
 * last attempt's. Looks up to three days ahead.
 */
export function nextAttemptAt(input: NextAttemptInput): Date {
  const windows = input.windows ?? DEFAULT_DAYPARTS;
  const gapEnd = new Date(Math.max(input.now.getTime(), (input.lastAttemptAt?.getTime() ?? 0) + input.minGapMinutes * 60_000));
  if (!input.rotateDayparts) return gapEnd;

  for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
    for (const d of DAYPARTS) {
      if (dayOffset === 0 && d === input.lastDaypart) continue;
      if (dayOffset > 0 && d === input.lastDaypart && DAYPARTS.length > 1) {
        // Next day: the same window is allowed only if it is not consecutive, i.e.
        // another window of ours would already have been offered. Keep it simple:
        // skip the same window on the following day too, which is the spec's
        // "no contact dialed in the same window on consecutive attempts".
        continue;
      }
      const [a, b] = windows[d];
      const start = instantAtLocal(input.zone, input.now, a, dayOffset);
      const end = instantAtLocal(input.zone, input.now, b, dayOffset);
      if (end <= gapEnd) continue;
      return start > gapEnd ? start : gapEnd;
    }
  }
  return gapEnd;
}

/** {{first_name}} style templates (dotted keys such as {{lead.firstName}} too); unknown keys render empty. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k: string) => (vars[k] ?? "").toString());
}

/** Phone formatting for texts: (305) 555-0100. */
export function prettyPhone(ten: string): string {
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : ten;
}
