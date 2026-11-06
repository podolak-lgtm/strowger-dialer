// Live transcription readiness, read from the engine (assist/live.ts): the
// campaign page and the queue form show it, and both refuse to switch
// transcription on while the jambonz account has no speech-to-text vendor.
import "server-only";
import { engine } from "@/lib/engine";

export type TranscriptionReadiness = { ok: boolean; problems: string[]; stt: string | null; anthropic: boolean };

/** Null when the engine did not answer. */
export async function transcriptionReadiness(): Promise<TranscriptionReadiness | null> {
  try {
    return await engine<TranscriptionReadiness>("/assist/readiness");
  } catch {
    return null;
  }
}

/** Why transcription may not go on, as one message; null when it may. */
export async function transcriptionRefusal(opts: { assist?: boolean } = {}): Promise<string | null> {
  const r = await transcriptionReadiness();
  if (!r) return "The engine did not answer, so the jambonz account could not be checked for a speech-to-text vendor. Try again in a minute.";
  if (!r.ok) return r.problems.join(" ");
  if (opts.assist && !r.anthropic) return "Live assist needs ANTHROPIC_API_KEY on the engine.";
  return null;
}
