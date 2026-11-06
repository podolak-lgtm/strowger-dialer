// One queue's settings, grouped the way the owner reads an ACD: distribution,
// priority, announcements, callback, blending, limits, survey. A plain form
// posting to `saveQueue`; every field has its default when left blank.
import type { Queue } from "@strowger/db";
import { QUEUE_STRATEGIES, STRATEGY_LABEL } from "@strowger/shared/inbound";
import Link from "next/link";
import { Button, Field, inputClass } from "@/components/ui";
import { deleteQueue, saveQueue } from "./actions";

type Opt = { id: string; name: string };
type Req = { skillId: string; minLevel: number };

const num = `${inputClass} py-1`;
const sel = `${inputClass} py-1 text-xs`;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-md border border-zinc-800 p-2">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</legend>
      {hint ? <p className="mb-2 text-xs text-zinc-500">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-center gap-1 text-xs text-zinc-300">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-3.5 w-3.5" /> {label}
    </label>
  );
}

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

export function QueueForm({ q, queues, skills, campaigns, audio, boxes, schedules }: { q: Queue | null; queues: Opt[]; skills: Opt[]; campaigns: Opt[]; audio: Opt[]; boxes: Opt[]; schedules: Opt[] }) {
  const req = (q?.requiredSkills as Req[] | null) ?? [];
  const others = queues.filter((x) => x.id !== q?.id);
  return (
    <details open={!q} className={`rounded-md border text-sm ${q ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
      <summary className="cursor-pointer select-none px-3 py-2">
        {q ? (
          <span>
            <span className="font-medium">{q.name}</span>
            <span className="ml-2 text-xs text-zinc-500">
              {STRATEGY_LABEL[q.strategy].split(":")[0]} · max wait {q.maxWaitSeconds}s{q.announce ? " · announces" : ""}
              {q.callbackEnabled ? " · callback" : ""}
              {q.surveyEnabled ? " · survey" : ""}
            </span>
          </span>
        ) : (
          <span className="text-zinc-400">New queue</span>
        )}
      </summary>
      <form action={saveQueue} className="space-y-3 px-3 pb-3">
        {q ? <input type="hidden" name="id" value={q.id} /> : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Queue">
            <input name="name" defaultValue={q?.name ?? ""} placeholder="Spanish support" className={inputClass} required />
          </Field>
          <Field label="Campaign context (optional)">
            <select name="campaignId" defaultValue={q?.campaignId ?? ""} className={inputClass}>
              <option value="">none</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Business hours">
            <select name="scheduleId" defaultValue={q?.scheduleId ?? ""} className={inputClass}>
              <option value="">always open</option>
              {schedules.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hold music">
            <AudioSelect name="holdAudioId" value={q?.holdAudioId} audio={audio} empty="silence" />
          </Field>
        </div>
        <div className="text-xs text-zinc-400">Required skills (all must be met):</div>
        <div className="flex flex-wrap gap-2">
          {skills.map((k) => {
            const r = req.find((x) => x.skillId === k.id);
            return (
              <label key={k.id} className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs">
                <input type="checkbox" name="skillId" value={k.id} defaultChecked={Boolean(r)} className="h-3.5 w-3.5" />
                {k.name} ≥
                <input name={`minLevel_${k.id}`} type="number" min="1" max="5" defaultValue={r?.minLevel ?? 3} className={`${inputClass} w-12 py-0.5 text-xs`} />
              </label>
            );
          })}
          {skills.length === 0 ? (
            <span className="text-xs text-zinc-500">
              No skills yet: add them on{" "}
              <Link href="/skills" className="underline">
                Skills
              </Link>
              . A queue with no skills takes any Ready agent (its campaign&apos;s first).
            </span>
          ) : null}
        </div>

        <Section title="Distribution" hint="Which free, qualified agent gets the next caller.">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px]">
            <Field label="Strategy">
              <select name="strategy" defaultValue={q?.strategy ?? "LONGEST_IDLE"} className={sel}>
                {QUEUE_STRATEGIES.map((x) => (
                  <option key={x} value={x}>
                    {STRATEGY_LABEL[x]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sticky (s)" hint="The agent who last handled the caller's lead gets them first, if free this soon. 0 = off.">
              <input name="stickySeconds" type="number" min="0" max="300" defaultValue={q?.stickySeconds ?? 20} className={num} />
            </Field>
          </div>
        </Section>

        <Section title="Priority" hint="Higher is answered first. An agent in several queues takes the highest-priority caller across them.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Base">
              <input name="priority" type="number" min="-100" max="100" defaultValue={q?.priority ?? 0} className={num} />
            </Field>
            <Field label="+ VIP lead">
              <input name="vipPriority" type="number" min="0" max="100" defaultValue={q?.vipPriority ?? 10} className={num} />
            </Field>
            <Field label="+ known lead">
              <input name="knownLeadPriority" type="number" min="0" max="100" defaultValue={q?.knownLeadPriority ?? 2} className={num} />
            </Field>
            <Field label="+1 per (s) waited">
              <input name="agingSeconds" type="number" min="0" max="3600" defaultValue={q?.agingSeconds ?? 60} className={num} />
            </Field>
          </div>
        </Section>

        <Section title="Announcements" hint="Spoken between hold music (text to speech). Goes quiet by itself if speech fails.">
          <div className="flex flex-wrap items-end gap-3">
            <Check name="announce" label="announce" defaultChecked={q?.announce ?? false} />
            <Check name="announcePosition" label="position in line" defaultChecked={q?.announcePosition ?? true} />
            <Check name="announceWait" label="estimated wait" defaultChecked={q?.announceWait ?? true} />
            <Field label="Every (s)">
              <input name="announceEverySeconds" type="number" min="15" max="600" defaultValue={q?.announceEverySeconds ?? 60} className={`${num} w-20`} />
            </Field>
          </div>
        </Section>

        <Section title="Callback" hint={'"Press 1 to get a call back without losing your place." The agent is reserved and the caller dialled from the number they called, within calling hours; two tries, then a note in the queue\'s voicemail box.'}>
          <div className="flex flex-wrap items-end gap-3">
            <Check name="callbackEnabled" label="offer a callback" defaultChecked={q?.callbackEnabled ?? false} />
            <Field label="After (s)">
              <input name="callbackOfferAfterSeconds" type="number" min="10" max="3600" defaultValue={q?.callbackOfferAfterSeconds ?? 90} className={`${num} w-20`} />
            </Field>
            <Field label="Offer recording">
              <AudioSelect name="callbackAudioId" value={q?.callbackAudioId} audio={audio} empty="spoken" />
            </Field>
          </div>
        </Section>

        <Section title="Blending" hint="Keeps outbound from starving this queue: the ratio pacer stops dialling for its agents.">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Hold outbound after (s)" hint="Oldest caller waiting this long. 0 = never.">
              <input name="blendWaitSeconds" type="number" min="0" max="3600" defaultValue={q?.blendWaitSeconds ?? 30} className={num} />
            </Field>
            <Field label="Reserve agents" hint="Always out of outbound while open.">
              <input name="reserveAgents" type="number" min="0" max="100" defaultValue={q?.reserveAgents ?? 0} className={num} />
            </Field>
          </div>
        </Section>

        <Section title="Limits">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Max wait (s)">
              <input name="maxWaitSeconds" type="number" min="15" max="3600" defaultValue={q?.maxWaitSeconds ?? 300} className={num} />
            </Field>
            <Field label="Then">
              <select name="overflowAction" defaultValue={q?.overflowAction ?? "VOICEMAIL"} className={sel}>
                <option value="VOICEMAIL">voicemail</option>
                <option value="QUEUE">another queue</option>
                <option value="HANGUP">hang up</option>
              </select>
            </Field>
            <Field label="Max callers waiting" hint="0 = no limit">
              <input name="maxWaiting" type="number" min="0" max="1000" defaultValue={q?.maxWaiting ?? 0} className={num} />
            </Field>
            <Field label="When full">
              <select name="fullAction" defaultValue={q?.fullAction ?? "VOICEMAIL"} className={sel}>
                <option value="VOICEMAIL">voicemail</option>
                <option value="QUEUE">the overflow queue</option>
                <option value="HANGUP">busy message, hang up</option>
              </select>
            </Field>
            <Field label="Overflow queue">
              <select name="overflowQueueId" defaultValue={q?.overflowQueueId ?? ""} className={sel}>
                <option value="">—</option>
                {others.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Voicemail box">
              <select name="voicemailBoxId" defaultValue={q?.voicemailBoxId ?? ""} className={sel}>
                <option value="">auto-create</option>
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Wrap-up (s)" hint="Then back to Ready unless paused. 0 = until the disposition.">
              <input name="wrapUpSeconds" type="number" min="0" max="600" defaultValue={q?.wrapUpSeconds ?? 30} className={num} />
            </Field>
            <Field label="Service level (s)" hint="Answered within, for reports.">
              <input name="slaSeconds" type="number" min="5" max="600" defaultValue={q?.slaSeconds ?? 20} className={num} />
            </Field>
          </div>
        </Section>

        <Section title="Survey" hint="After the agent hangs up the caller is asked for 1 to 5; shown in the Inbound report. Not yet tried on a live call: leave off until a test call confirms it.">
          <div className="flex flex-wrap items-end gap-3">
            <Check name="surveyEnabled" label="post-call survey" defaultChecked={q?.surveyEnabled ?? false} />
            <Field label="Question recording">
              <AudioSelect name="surveyAudioId" value={q?.surveyAudioId} audio={audio} empty="spoken" />
            </Field>
          </div>
        </Section>

        <div className="flex items-end gap-2">
          <Button type="submit" variant="ghost">
            {q ? "Save" : "Add queue"}
          </Button>
          {q ? (
            <Button type="submit" variant="danger" formAction={deleteQueue}>
              ✕
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
