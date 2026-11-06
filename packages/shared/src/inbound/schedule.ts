/**
 * Business hours for inbound queues and numbers (owner, 6 Nov: "the best at
 * inbound"). A schedule is data: a zone, weekly open ranges per weekday,
 * holiday dates, and a manual "closed now" switch. `evaluateSchedule` says
 * whether it is open at a moment and, when closed, why and which message to
 * play. Pure: the engine and the admin page both call it.
 *
 * Ranges are local "HH:MM" pairs, end exclusive. A range whose end is at or
 * before its start runs overnight: ["22:00","02:00"] on Friday is open from
 * Friday 22:00 to Saturday 02:00. "24:00" is accepted as an end.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export type TimeRange = readonly [string, string];

/** `{"1": [["09:00","17:00"]], …}` keyed by weekday, Sunday = "0". A missing day is closed. */
export type WeeklyHours = Partial<Record<string, readonly TimeRange[]>>;

export interface Holiday {
  /** Local date in the schedule's zone, YYYY-MM-DD. The whole day is closed. */
  date: string;
  name?: string | null;
  /** Message audio for that day; falls back to the schedule's closed greeting. */
  audioId?: string | null;
}

export interface ScheduleDef {
  timezone: string;
  weekly: WeeklyHours;
  holidays?: readonly Holiday[];
  /** Manual override: closed now, until `closedUntil` (null = until switched off). */
  closedNow?: boolean;
  closedUntil?: Date | string | null;
  closedNowAudioId?: string | null;
}

export type ScheduleState =
  | { open: true }
  | { open: false; reason: "override"; audioId: string | null }
  | { open: false; reason: "holiday"; holiday: Holiday; audioId: string | null }
  | { open: false; reason: "hours" | "timezone"; audioId: null };

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "09:00" → 540. Null for anything that is not a valid time ("24:00" allowed). */
export function parseClock(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

interface Local {
  date: string; // YYYY-MM-DD
  weekday: Weekday;
  minutes: number;
}

/** Local calendar date, weekday and minute of day in `zone`. Null for an unknown zone. */
export function localParts(zone: string, at: Date): Local | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (weekday < 0 || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekday as Weekday, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function rangesOf(weekly: WeeklyHours, day: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const r of weekly[String(day)] ?? []) {
    const start = parseClock(r[0]);
    const end = parseClock(r[1]);
    if (start === null || end === null) continue;
    out.push({ start, end });
  }
  return out;
}

/** True when the weekly hours alone have the line open at this local moment. */
export function withinWeeklyHours(weekly: WeeklyHours, weekday: Weekday, minutes: number): boolean {
  for (const r of rangesOf(weekly, weekday)) {
    if (r.end > r.start) {
      if (minutes >= r.start && minutes < r.end) return true;
    } else if (minutes >= r.start) return true; // overnight, first half
  }
  const yesterday = (weekday + 6) % 7;
  for (const r of rangesOf(weekly, yesterday)) {
    if (r.end <= r.start && minutes < r.end) return true; // overnight spill from the day before
  }
  return false;
}

export function evaluateSchedule(s: ScheduleDef, now: Date = new Date()): ScheduleState {
  if (s.closedNow) {
    const until = s.closedUntil ? new Date(s.closedUntil) : null;
    if (!until || Number.isNaN(until.getTime()) || now < until) return { open: false, reason: "override", audioId: s.closedNowAudioId ?? null };
  }
  const local = localParts(s.timezone, now);
  if (!local) return { open: false, reason: "timezone", audioId: null };
  const holiday = (s.holidays ?? []).find((h) => h.date === local.date);
  if (holiday) return { open: false, reason: "holiday", holiday, audioId: holiday.audioId ?? null };
  return withinWeeklyHours(s.weekly, local.weekday, local.minutes) ? { open: true } : { open: false, reason: "hours", audioId: null };
}

/** "09:00-17:00, 18:00-20:00" → ranges; bad pieces are dropped. The admin form's text box. */
export function parseRangesText(text: string): TimeRange[] {
  return text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split(/\s*[-–]\s*/))
    .filter((x): x is [string, string] => x.length === 2 && parseClock(x[0]!) !== null && parseClock(x[1]!) !== null)
    .map(([a, b]) => [a.padStart(5, "0"), b.padStart(5, "0")] as const);
}

export function rangesText(ranges: readonly TimeRange[] | undefined): string {
  return (ranges ?? []).map((r) => `${r[0]}-${r[1]}`).join(", ");
}

/** Read stored JSON defensively: anything malformed becomes "closed that day". */
export function parseWeekly(raw: unknown): WeeklyHours {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TimeRange[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(k) || !Array.isArray(v)) continue;
    out[k] = v.filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && typeof r[0] === "string" && typeof r[1] === "string");
  }
  return out;
}

export function parseHolidays(raw: unknown): Holiday[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is Holiday => Boolean(h) && typeof (h as Holiday).date === "string" && /^\d{4}-\d{2}-\d{2}$/.test((h as Holiday).date))
    .map((h) => ({ date: h.date, name: h.name ?? null, audioId: h.audioId ?? null }));
}

/**
 * A wall-clock time in `zone` ("2026-11-26T17:30", the admin form's
 * datetime-local) as a UTC instant. Null for junk or an unknown zone.
 */
export function zonedTimeToUtc(local: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes: the zone's offset at the guess, then at the corrected instant (DST edges).
  let t = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = localParts(zone, new Date(t));
    if (!p) return null;
    const [y, mo, d] = p.date.split("-").map(Number) as [number, number, number];
    const seen = Date.UTC(y, mo - 1, d, Math.floor(p.minutes / 60), p.minutes % 60);
    t += asUtc - seen;
  }
  return new Date(t);
}

/** The UTC instant as the zone's wall clock "YYYY-MM-DDTHH:MM" (to fill the form back in). */
export function utcToZonedInput(at: Date, zone: string): string {
  const p = localParts(zone, at);
  if (!p) return "";
  return `${p.date}T${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
}
