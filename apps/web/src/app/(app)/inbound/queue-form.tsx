// One queue's settings, grouped the way the owner reads an ACD: distribution,
// priority, announcements, callback, blending, limits, survey. A plain form
// posting to `saveQueue`; every field has its default when left blank.
import type { Queue } from "@strowger/db";
import { AI_GREETING_MAX, AI_INSTRUCTIONS_MAX, AI_KNOWLEDGE_MAX, AI_LLM_VENDORS, AI_MODES, AI_MODE_LABEL, DEFAULT_AI_MODEL, DEFAULT_HANDOFF_PHRASES, QUEUE_STRATEGIES, STRATEGY_LABEL } from "@strowger/shared/inbound";
import Link from "next/link";
import { Button, Field, inputClass } from "@/components/ui";
import { deleteQueue, saveQueue, type AiReadiness } from "./actions";
import { AiPromptTest } from "./ai-test";

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

/** What the AI answer needs on the jambonz account, as the page found it. */
function AiSetup({ ready }: { ready: AiReadiness | null }) {
  if (!ready) return <p className="text-xs text-amber-300">The engine did not answer, so the jambonz account could not be checked. The AI answer cannot be turned on until it does.</p>;
  if (ready.ok) return <p className="text-xs text-emerald-300">jambonz is ready: speech-to-text {ready.stt}, speech {ready.tts}.</p>;
  return (
    <div className="space-y-1 text-xs text-amber-200">
      <p className="font-medium">The AI answer stays off until this is fixed:</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {ready.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function QueueForm({ q, queues, skills, campaigns, audio, boxes, schedules, aiReady }: { q: Queue | null; queues: Opt[]; skills: Opt[]; campaigns: Opt[]; audio: Opt[]; boxes: Opt[]; schedules: Opt[]; aiReady: AiReadiness | null }) {
  const req = (q?.requiredSkills as Req[] | null) ?? [];
  const others = queues.filter((x) => x.id !== q?.id);
  return (
    <details open={!q} className={`rounded-md border text-sm ${q ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
      <summary className="cursor-pointer select-none px-3 py-2">
        {q ? (
          <span>
            <span className="font-medium">{q.name}</span>
            <span className="ml-2 text-xs text-zinc-500">
              {STRATEGY_LABEL[q.strategy].split(":")[0]} · max wait {q.maxWaitSeconds}s{q.minHoldSeconds ? ` · forced hold ${q.minHoldSeconds}s` : ""}{q.announce ? " · announces" : ""}
              {q.callbackEnabled ? " · callback" : ""}
              {q.surveyEnabled ? " · survey" : ""}
              {q.aiEnabled ? ` · AI ${q.aiMode.toLowerCase()}` : ""}
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
          <div className="mt-2 grid grid-cols-1 items-end gap-2 sm:grid-cols-[140px_1fr]">
            <Field label="Forced hold (s)" hint="0 = off. Max wait must be at least this.">
              <input name="minHoldSeconds" type="number" min="0" max="600" step="5" defaultValue={q?.minHoldSeconds ?? 0} className={num} />
            </Field>
            <div className="space-y-1">
              <p className="text-xs text-zinc-500">Callers wait at least this long before an agent is offered the call. Some callers hang up while waiting; they show as &apos;abandoned in forced hold&apos;.</p>
              <Check name="minHoldBypassVip" label="VIP leads skip the forced hold" defaultChecked={q?.minHoldBypassVip ?? true} />
            </div>
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

        <Section
          title="AI answer"
          hint="A built-in AI customer service answers the call. It says it is an automated assistant, never takes card numbers, and stays inside your instructions. A caller who says a hand-off phrase goes straight to a person, ahead of the line and with no forced hold; the agent's screen shows the AI's summary."
        >
          <div className="space-y-2">
            <AiSetup ready={aiReady} />
            <div className="flex flex-wrap items-end gap-3">
              <Check name="aiEnabled" label="AI answers this queue" defaultChecked={q?.aiEnabled ?? false} />
              <Field label="When">
                <select name="aiMode" defaultValue={q?.aiMode ?? "FIRST"} className={sel}>
                  {AI_MODES.map((m) => (
                    <option key={m} value={m}>
                      {AI_MODE_LABEL[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Overflow after (s)" hint="Overflow mode: no agent free this long. 0 = at once.">
                <input name="aiAfterSeconds" type="number" min="0" max="3600" defaultValue={q?.aiAfterSeconds ?? 60} className={`${num} w-24`} />
              </Field>
              <Field label="Hand off after (min)">
                <input name="aiMaxMinutes" type="number" min="1" max="60" defaultValue={q?.aiMaxMinutes ?? 10} className={`${num} w-20`} />
              </Field>
            </div>
            <Field label="Greeting" hint="The first words. If it does not say so, “I'm an automated assistant.” is added.">
              <input name="aiGreeting" maxLength={AI_GREETING_MAX} defaultValue={q?.aiGreeting ?? ""} placeholder="Thanks for calling Exit Solar. How can I help you today?" className={inputClass} />
            </Field>
            <Field label="Instructions" hint="Who the assistant is, what the business does, the tone, what it may and may not do. Fixed safety rules always come first.">
              <textarea name="aiInstructions" rows={4} maxLength={AI_INSTRUCTIONS_MAX} defaultValue={q?.aiInstructions ?? ""} placeholder="You are Sunny, the help line for Exit Solar. Callers are homeowners with a solar contract. Be warm and brief. You can explain how the review works and book a call back; anything about money goes to a person." className={inputClass} />
            </Field>
            <Field label={`Knowledge (FAQ, up to ${AI_KNOWLEDGE_MAX.toLocaleString()} characters)`} hint="Paste your FAQ. The assistant answers from it and says it is not sure otherwise.">
              <textarea name="aiKnowledge" rows={4} maxLength={AI_KNOWLEDGE_MAX} defaultValue={q?.aiKnowledge ?? ""} placeholder="Hours: Monday to Friday, 9 to 6 Eastern…" className={inputClass} />
            </Field>
            <Field label="Hand-off phrases" hint="Commas or lines. Said by the caller = straight to a person, before the AI answers.">
              <textarea name="aiHandoffPhrases" rows={2} defaultValue={(q?.aiHandoffPhrases.length ? q.aiHandoffPhrases : DEFAULT_HANDOFF_PHRASES).join(", ")} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Field label="Speech-to-text vendor" hint="Blank = the account's (Deepgram first).">
                <input name="aiSttVendor" defaultValue={q?.aiSttVendor ?? ""} placeholder={aiReady?.stt ?? "deepgram"} className={num} />
              </Field>
              <Field label="Speech vendor" hint="Blank = the account's (Cartesia first).">
                <input name="aiTtsVendor" defaultValue={q?.aiTtsVendor ?? ""} placeholder={aiReady?.tts ?? "cartesia"} className={num} />
              </Field>
              <Field label="Voice" hint="The vendor's voice id; blank = its default.">
                <input name="aiVoice" defaultValue={q?.aiVoice ?? ""} className={num} />
              </Field>
              <Field label="Language">
                <input name="aiLanguage" defaultValue={q?.aiLanguage ?? "en-US"} className={num} />
              </Field>
              <Field label="LLM vendor" hint="Anthropic uses the engine's key; others need an LLM service in jambonz.">
                <select name="aiLlmVendor" defaultValue={q?.aiLlmVendor ?? "anthropic"} className={sel}>
                  {AI_LLM_VENDORS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <input name="aiModel" defaultValue={q?.aiModel ?? DEFAULT_AI_MODEL} className={num} />
              </Field>
            </div>
            <AiPromptTest />
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer select-none text-zinc-400">What has to be set up in jambonz first</summary>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>Account → Speech services: a speech-to-text vendor with “Use for speech-to-text” ticked (Deepgram is the usual pick for phone calls). Cartesia is already there for speech.</li>
                <li>The engine&apos;s public URL must be https: jambonz opens wss://…/ws/ai on it for each AI call (nothing to add in jambonz; no second application is needed).</li>
                <li>Anthropic: nothing in jambonz, the engine sends its own key. Any other LLM vendor: Account → LLM services → add it.</li>
                <li>The jambonz account must be on a release with the agent verb (jambonz.cloud has it). Make one test call before putting a live line on it.</li>
              </ol>
            </details>
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
