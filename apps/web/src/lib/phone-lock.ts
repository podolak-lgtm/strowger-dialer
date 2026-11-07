// One phone per browser (owner, 7 Nov: "one agent, one call control, ever"). Every page that can register the
// user's SIP account (the console's main window, the floor) talks on BroadcastChannel("strowger-phone-<userId>").
// HANDOFF "Call path hardening, browser (owner, 7 Nov)".
//
//   who      a window wants the phone; whoever holds it answers "mine"
//   mine     "I hold the phone (or I am connecting it)"
//   release  "use it here": the holder lets go and answers "released", or answers "busy" while on a call
//   released the holder hung up and disconnected
//   busy     the holder is on a call (or in wrap-up) and keeps the phone
//   free     the holder let go (closed, released, logged out of the phone); a floor page may register now
//
// The console window always wins over the floor: a floor page never answers "who" unless it is mid-supervision.

export type PhoneMsg = { t: "who" | "mine" | "release" | "released" | "busy" | "free"; from: string; kind: "console" | "floor" };

export const phoneChannelName = (userId: string) => `strowger-phone-${userId}`;

/** Sortable per-window id: the earlier window has the lower id, so it wins when two windows ask at once. */
export function newTabId(): string {
  return `${Date.now().toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ask the channel before registering. "free": nobody holds it (or the holder released it); "theirs": another
 * window holds it, or another console window asked at the same moment and has the lower id; "busy": the holder
 * is on a call and refused to release.
 */
export function askPhoneChannel(chan: BroadcastChannel, tabId: string, opts: { takeOver: boolean; kind: "console" | "floor" }): Promise<"free" | "theirs" | "busy"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: "free" | "theirs" | "busy") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chan.removeEventListener("message", onMsg);
      resolve(r);
    };
    const onMsg = (e: MessageEvent<PhoneMsg>) => {
      const m = e.data;
      if (!m || m.from === tabId) return;
      if (opts.takeOver) {
        if (m.t === "released") finish("free");
        else if (m.t === "busy") finish("busy");
        return;
      }
      if (m.t === "mine") finish("theirs");
      // Two console windows asking at once (two tabs restored together): the lower id wins, this one backs off.
      else if (m.t === "who" && opts.kind === "console" && m.kind === "console" && m.from < tabId) finish("theirs");
    };
    chan.addEventListener("message", onMsg);
    const msg: PhoneMsg = { t: opts.takeOver ? "release" : "who", from: tabId, kind: opts.kind };
    try {
      chan.postMessage(msg);
    } catch {
      /* channel closed */
    }
    const timer = setTimeout(() => finish("free"), opts.takeOver ? 1500 : 500);
  });
}

export function postPhone(chan: BroadcastChannel | null, msg: PhoneMsg): void {
  try {
    chan?.postMessage(msg);
  } catch {
    /* closed */
  }
}

/** A promise that rejects after `ms` (the original is left to settle on its own, its rejection swallowed). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** An INVITE is answered only within this long after this page asked for a supervision leg. */
export const SUPERVISION_ANSWER_WINDOW_MS = 30_000;

/** Turn the browser's audio back on: play() every audio element that has something to play (needs a click). */
export async function playAllAudio(): Promise<boolean> {
  const els = Array.from(document.querySelectorAll("audio")).filter((el) => el.srcObject || el.currentSrc || el.src);
  const r = await Promise.all(els.map((el) => el.play().then(() => true, () => false)));
  return r.every(Boolean);
}
