"use client";

// Transcription & assist tab (HANDOFF "Live transcription and agent assist").
// Everything here goes through the one Save; switching transcription on is
// refused there when the jambonz account has no speech-to-text vendor.
import { ASSIST_MODELS, STT_SETUP_STEP } from "@strowger/shared/assist";
import { ALL_PARTY_CONSENT_STATES, DEFAULT_BANNED_PHRASES, DISCLOSURE_WINDOW_SECONDS } from "@strowger/shared/compliance";
import type { TranscriptionReadiness } from "@/lib/assist-readiness";
import { Card, Hint, SettingCheck, SettingInput, SettingSelect, SettingTextarea, useEditor } from "./editor-ui";

export function AssistTab({ ready }: { ready: TranscriptionReadiness | null }) {
  const { draft, errors, edit } = useEditor();
  const on = draft.settings.transcriptionOn === true;
  const err = errors["settings.transcriptionOn"] ?? errors["settings.liveAssistOn"];
  const banned = String(draft.settings.bannedPhrases ?? "");
  return (
    <>
      <Card title="Live transcription">
        <div className="space-y-2.5">
          {ready === null ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">The engine did not answer, so the jambonz account could not be checked for a speech-to-text vendor.</p>
          ) : ready.ok ? (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">Speech-to-text on the jambonz account: {ready.stt}.</p>
          ) : (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{ready.problems.join(" ") || STT_SETUP_STEP}</p>
          )}
          <SettingCheck k="transcriptionOn" label="Transcribe calls live (customer and agent, shown on the agent's console and to a supervisor listening in)" />
          {err ? (
            <p data-field="settings.transcriptionOn" className="text-xs text-red-400">
              {err}
            </p>
          ) : null}
          <Hint more={<>Each side of the call is its own jambonz leg, transcribed by the account&apos;s speech-to-text vendor; minutes are billed per leg. An agent&apos;s own side starts with the first log in after this is switched on. Off: calls are exactly as before.</>}>Both sides, interim words greyed until final.</Hint>
          <SettingCheck k="postCallSummaryOn" label="After the call: write an AI summary (3 to 5 sentences) into the lead's notes" />
          <SettingCheck k="suggestDispositionOn" label="After the call: pre-select a suggested disposition in wrap-up (the agent confirms)" />
        </div>
      </Card>

      <Card title="Live assist">
        <div className="space-y-2.5">
          <SettingCheck k="liveAssistOn" label="Coach the agent from what the customer says: rebuttal cards, a suggested next line, script progress" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SettingSelect k="assistModel" label="AI model">
              {ASSIST_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === "claude-haiku-5-5" ? " (fast, default)" : ""}
                </option>
              ))}
            </SettingSelect>
            <SettingInput k="assistMinGapSeconds" label="At most one AI line every (seconds)" type="number" min="2" max="120" />
            <SettingInput k="assistMaxPerCall" label="AI lines per call, at most" type="number" min="0" max="200" />
          </div>
          <Hint more={<>A rebuttal from this campaign&apos;s library is matched first and shown at once; the AI is asked only when none fits, and never for fillers under three words. It is told the script, the rebuttals, the lead (name, city, state, type, notes) and the last 12 turns, and never to invent facts, prices or guarantees.</>}>Needs transcription on.</Hint>
          {!on && draft.settings.liveAssistOn === true ? <p className="text-xs text-amber-300">Live assist runs only while transcription is on.</p> : null}
        </div>
      </Card>

      <Card title="Compliance on the live transcript">
        <div className="space-y-2.5">
          <SettingCheck k="spokenDisclosureRequired" label={`The agent must say the recording disclosure: red banner "Give the recording disclosure now" when it is not heard within ${DISCLOSURE_WINDOW_SECONDS} s`} />
          <SettingTextarea k="disclosurePhrases" label="Disclosure phrases (one per line; any one heard counts)" rows={3} />
          <SettingTextarea k="bannedPhrases" label="Banned phrases (one per line): the agent is alerted, the call and the floor log it" rows={4} placeholder={DEFAULT_BANNED_PHRASES.join("\n")} />
          {!banned.trim() ? (
            <button type="button" onClick={() => edit((d) => ({ ...d, settings: { ...d.settings, bannedPhrases: DEFAULT_BANNED_PHRASES.join("\n") } }))} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
              Use the suggested list
            </button>
          ) : null}
          <Hint more={<>Ordinary phrases such as &ldquo;feel free&rdquo; and &ldquo;toll-free&rdquo; do not count. With &ldquo;Play recording disclosure when bridged&rdquo; on (Compliance tab) the file is the disclosure and no spoken one is required. All-party consent states for recording (check with counsel): {ALL_PARTY_CONSENT_STATES.join(", ")}.</>}>Checked only while transcription is on.</Hint>
        </div>
      </Card>
    </>
  );
}
