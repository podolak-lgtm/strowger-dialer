// Call-screening services (Google Call Screen, carrier assistants, iOS Live
// Voicemail prompts) answer with a short scripted question. Matching the
// first seconds of transcript against these phrases is how we tell a screener
// from a person. Data, not code: add phrases here as new services appear.

export const SCREENER_PHRASES: ReadonlyArray<RegExp> = [
  /the person you.?re calling is using a screening service/i,
  /using a (call )?screening service/i,
  /(say|state) (your name and )?(why|the reason) (you.?re|you are) calling/i,
  /who.?s calling and why/i,
  /please (tell me|say) (who you are|your name)/i,
  /google (call )?screen/i,
  /this call is being screened/i,
  /i.?ll (pass|relay) (this|your message|that) (on|along)/i,
  /can you tell me what (this|this call|your call) is (about|regarding)/i,
  /live voicemail/i,
  /i (can|will) take a message/i,
  /the person you.?re trying to reach (is )?(not )?available.*(record|message)/i,
];

export interface ScreenerMatch {
  matched: boolean;
  phrase?: string;
}

export function detectScreener(transcript: string): ScreenerMatch {
  const t = transcript.replace(/\s+/g, " ").trim();
  if (!t) return { matched: false };
  for (const re of SCREENER_PHRASES) {
    const m = re.exec(t);
    if (m) return { matched: true, phrase: m[0] };
  }
  return { matched: false };
}
