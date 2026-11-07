/**
 * State holidays on which telemarketing calls are banned (state-rules.ts `holidays`). Until 7 Nov 2026 the
 * matrix carried a `noHolidayCalls` flag that nothing enforced; this module turns each named holiday into dates.
 *
 * Conservative on purpose: a fixed-date holiday that falls on a weekend also blocks its weekday "observed" day
 * (Saturday → Friday, Sunday → Monday), and Election Day counts every year, because some states' lists include
 * municipal elections. Blocking one extra day costs a day of dialing; calling on a banned day costs a lawsuit.
 */

export type HolidayKey =
  | "NEW_YEAR"
  | "MLK"
  | "PRESIDENTS"
  | "MARDI_GRAS"
  | "GOOD_FRIDAY"
  | "CONFEDERATE_MEMORIAL"
  | "RI_INDEPENDENCE"
  | "MEMORIAL"
  | "JEFFERSON_DAVIS"
  | "FLAG_DAY"
  | "JUNETEENTH"
  | "INDEPENDENCE"
  | "PIONEER_DAY"
  | "VICTORY_DAY"
  | "LABOR"
  | "COLUMBUS"
  | "ALL_SAINTS"
  | "ELECTION_DAY"
  | "VETERANS"
  | "THANKSGIVING"
  | "CHRISTMAS_EVE"
  | "CHRISTMAS"
  | "NEW_YEARS_EVE";

/** Federal holidays most state lists start from. */
export const FEDERAL_HOLIDAYS: readonly HolidayKey[] = ["NEW_YEAR", "MLK", "PRESIDENTS", "MEMORIAL", "JUNETEENTH", "INDEPENDENCE", "LABOR", "COLUMBUS", "VETERANS", "THANKSGIVING", "CHRISTMAS"];

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The n-th `weekday` (0 = Sunday) of month `m` (1-12). */
export function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return iso(y, m, day);
}

/** The last `weekday` of month `m` (1-12). */
export function lastWeekday(y: number, m: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((lastDow - weekday + 7) % 7));
}

/** Easter Sunday (Anonymous Gregorian algorithm), as [month, day]. */
export function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

function shift(dateIso: string, days: number): string {
  const y = Number(dateIso.slice(0, 4));
  const m = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Fixed-date holiday plus its weekday observance when it falls on a weekend. */
function fixed(y: number, m: number, d: number): string[] {
  const date = iso(y, m, d);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return [date, shift(date, -1)];
  if (dow === 0) return [date, shift(date, 1)];
  return [date];
}

function datesOf(key: HolidayKey, y: number): string[] {
  const [em, ed] = easter(y);
  const easterIso = iso(y, em, ed);
  switch (key) {
    case "NEW_YEAR":
      return fixed(y, 1, 1);
    case "MLK":
      return [nthWeekday(y, 1, 1, 3)];
    case "PRESIDENTS":
      return [nthWeekday(y, 2, 1, 3)];
    case "MARDI_GRAS":
      return [shift(easterIso, -47)];
    case "GOOD_FRIDAY":
      return [shift(easterIso, -2)];
    case "CONFEDERATE_MEMORIAL":
      return [nthWeekday(y, 4, 1, 4)];
    case "RI_INDEPENDENCE":
      return fixed(y, 5, 4);
    case "MEMORIAL":
      return [lastWeekday(y, 5, 1)];
    case "JEFFERSON_DAVIS":
      return [nthWeekday(y, 6, 1, 1)];
    case "FLAG_DAY":
      return fixed(y, 6, 14);
    case "JUNETEENTH":
      return fixed(y, 6, 19);
    case "INDEPENDENCE":
      return fixed(y, 7, 4);
    case "PIONEER_DAY":
      return fixed(y, 7, 24);
    case "VICTORY_DAY":
      return [nthWeekday(y, 8, 1, 2)];
    case "LABOR":
      return [nthWeekday(y, 9, 1, 1)];
    case "COLUMBUS":
      return [nthWeekday(y, 10, 1, 2)];
    case "ALL_SAINTS":
      return fixed(y, 11, 1);
    case "ELECTION_DAY":
      // The Tuesday after the first Monday in November.
      return [shift(nthWeekday(y, 11, 1, 1), 1)];
    case "VETERANS":
      return fixed(y, 11, 11);
    case "THANKSGIVING":
      return [nthWeekday(y, 11, 4, 4)];
    case "CHRISTMAS_EVE":
      return [iso(y, 12, 24)];
    case "CHRISTMAS":
      return fixed(y, 12, 25);
    case "NEW_YEARS_EVE":
      return [iso(y, 12, 31)];
  }
}

/** Every date (YYYY-MM-DD) in `year` on which one of `keys` is held or observed. */
export function holidayDates(keys: readonly HolidayKey[], year: number): Set<string> {
  const out = new Set<string>();
  for (const k of keys) for (const d of datesOf(k, year)) out.add(d);
  // New Year's Day on a Saturday is observed on Friday 31 December of the year before.
  if (keys.includes("NEW_YEAR") && new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) out.add(iso(year, 12, 31));
  return out;
}

/** The holiday (if any) `dateIso` falls on, among `keys`. */
export function holidayOn(keys: readonly HolidayKey[], dateIso: string): HolidayKey | null {
  const year = Number(dateIso.slice(0, 4));
  for (const k of keys) {
    const dates = new Set(datesOf(k, year));
    if (k === "NEW_YEAR" && new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) dates.add(iso(year, 12, 31));
    if (dates.has(dateIso)) return k;
  }
  return null;
}
