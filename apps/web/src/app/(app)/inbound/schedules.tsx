// Business hours: weekly ranges per weekday, holidays with their own message,
// a "closed now" switch, and what a caller hears and where they go when
// closed. Evaluated by shared/inbound/schedule.ts (the engine and this page).
import type { Schedule } from "@strowger/db";
import { WEEKDAY_NAMES, evaluateSchedule, parseHolidays, parseWeekly, rangesText, utcToZonedInput } from "@strowger/shared/inbound";
import { Badge, Button, Field, inputClass } from "@/components/ui";
import { deleteSchedule, saveSchedule, setClosedNow } from "./actions";

type Opt = { id: string; name: string };

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico"];
const sel = `${inputClass} py-1 text-xs`;

function AudioSelect({ name, value, audio, empty }: { name: string; value: string | null | undefined; audio: Opt[]; empty: string }) {
  return (
    <select name={name} defaultValue={value ?? ""} className={sel}>
      <option value="">{empty}</option>
      {audio.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

export function StateBadge({ s, now }: { s: Schedule; now: Date }) {
  const st = evaluateSchedule({ timezone: s.timezone, weekly: parseWeekly(s.weekly), holidays: parseHolidays(s.holidays), closedNow: s.closedNow, closedUntil: s.closedUntil, closedNowAudioId: s.closedNowAudioId }, now);
  if (st.open) return <Badge tone="green">open now</Badge>;
  const why = st.reason === "override" ? "closed (switched)" : st.reason === "holiday" ? `closed: ${st.holiday.name ?? "holiday"}` : st.reason === "timezone" ? "bad time zone" : "closed (hours)";
  return <Badge tone={st.reason === "override" ? "red" : "amber"}>{why}</Badge>;
}

export function ScheduleForm({ s, now, audio, queues, ivrs, boxes }: { s: Schedule | null; now: Date; audio: Opt[]; queues: Opt[]; ivrs: Opt[]; boxes: Opt[] }) {
  const weekly = parseWeekly(s?.weekly ?? { "1": [["09:00", "17:00"]], "2": [["09:00", "17:00"]], "3": [["09:00", "17:00"]], "4": [["09:00", "17:00"]], "5": [["09:00", "17:00"]] });
  const holidays = parseHolidays(s?.holidays ?? []);
  const tz = s?.timezone ?? "America/New_York";
  const action = s?.closedAction ?? "MESSAGE";
  return (
    <details open={!s} className={`rounded-md border text-sm ${s ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2">
        {s ? (
          <>
            <span className="font-medium">{s.name}</span>
            <span className="text-xs text-zinc-500">{s.timezone}</span>
            <StateBadge s={s} now={now} />
          </>
        ) : (
          <span className="text-zinc-400">New schedule</span>
        )}
      </summary>
      {s ? (
        <form action={setClosedNow} className="flex items-center gap-2 px-3 pb-2 text-xs">
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="closedNow" value={s.closedNow ? "0" : "1"} />
          <Button type="submit" variant={s.closedNow ? "ghost" : "danger"}>
            {s.closedNow ? "Reopen now" : "Close now"}
          </Button>
          <span className="text-zinc-500">{s.closedNow ? `Closed by hand${s.closedUntil ? ` until ${utcToZonedInput(s.closedUntil, s.timezone).replace("T", " ")}` : ""}.` : "Snow day, meeting, outage: closes every queue and number on this schedule at once."}</span>
        </form>
      ) : null}
      <form action={saveSchedule} className="space-y-3 px-3 pb-3">
        {s ? <input type="hidden" name="id" value={s.id} /> : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Schedule">
            <input name="name" defaultValue={s?.name ?? ""} placeholder="Office hours" className={inputClass} required />
          </Field>
          <Field label="Time zone">
            <select name="timezone" defaultValue={tz} className={inputClass}>
              {[...new Set([tz, ...ZONES])].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset className="rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Weekly hours</legend>
          <p className="mb-2 text-xs text-zinc-500">Open ranges, comma separated, e.g. 09:00-12:00, 13:00-17:00. An end before the start runs overnight (22:00-02:00). Blank = closed.</p>
          <div className="grid grid-cols-[90px_1fr] items-center gap-1">
            {WEEKDAY_NAMES.map((d, i) => (
              <label key={d} className="contents">
                <span className="text-xs text-zinc-400">{d}</span>
                <input name={`day${i}`} defaultValue={rangesText(weekly[String(i)])} placeholder="closed" className={`${inputClass} py-1 font-mono text-xs`} />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Holidays</legend>
          <p className="mb-2 text-xs text-zinc-500">Closed all day in the schedule&apos;s zone. Clear the date to remove one.</p>
          <div className="space-y-1">
            {[...holidays, { date: "", name: "", audioId: null }].map((h, i) => (
              <div key={`${h.date}-${i}`} className="grid grid-cols-1 gap-1 sm:grid-cols-[150px_1fr_1fr]">
                <input type="date" name={`holidayDate_${i}`} defaultValue={h.date} className={`${inputClass} py-1 text-xs`} />
                <input name={`holidayName_${i}`} defaultValue={h.name ?? ""} placeholder={h.date ? "" : "add a holiday"} className={`${inputClass} py-1 text-xs`} />
                <AudioSelect name={`holidayAudio_${i}`} value={h.audioId} audio={audio} empty="closed greeting" />
              </div>
            ))}
          </div>
        </fieldset>
        <fieldset className="rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">When closed</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Closed greeting">
              <AudioSelect name="closedGreetingAudioId" value={s?.closedGreetingAudioId} audio={audio} empty="spoken closed message" />
            </Field>
            <Field label="Then">
              <select name="closedAction" defaultValue={action} className={sel}>
                <option value="MESSAGE">hang up after the greeting</option>
                <option value="VOICEMAIL">voicemail box</option>
                <option value="IVR">IVR menu</option>
                <option value="QUEUE">another queue</option>
              </select>
            </Field>
            <Field label="Voicemail box">
              <select name="closedTarget_VOICEMAIL" defaultValue={action === "VOICEMAIL" ? (s?.closedTargetId ?? "") : ""} className={sel}>
                <option value="">—</option>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="IVR / queue">
              <div className="grid grid-cols-2 gap-1">
                <select name="closedTarget_IVR" defaultValue={action === "IVR" ? (s?.closedTargetId ?? "") : ""} className={sel}>
                  <option value="">— IVR —</option>
                  {ivrs.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <select name="closedTarget_QUEUE" defaultValue={action === "QUEUE" ? (s?.closedTargetId ?? "") : ""} className={sel}>
                  <option value="">— queue —</option>
                  {queues.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
        </fieldset>
        <fieldset className="rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Closed now (override)</legend>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-1 text-xs text-zinc-300">
              <input type="checkbox" name="closedNow" defaultChecked={s?.closedNow ?? false} className="h-3.5 w-3.5" /> closed now
            </label>
            <Field label={`Until (${tz})`} hint="Blank = until switched off.">
              <input type="datetime-local" name="closedUntil" defaultValue={s?.closedUntil ? utcToZonedInput(s.closedUntil, tz) : ""} className={`${inputClass} py-1 text-xs`} />
            </Field>
            <Field label="Message">
              <AudioSelect name="closedNowAudioId" value={s?.closedNowAudioId} audio={audio} empty="closed greeting" />
            </Field>
          </div>
        </fieldset>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="ghost">
            {s ? "Save" : "Add schedule"}
          </Button>
          {s ? (
            <Button type="submit" variant="danger" formAction={deleteSchedule}>
              ✕
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
