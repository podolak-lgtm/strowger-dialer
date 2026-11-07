"use client";

// Audio watchdog for the agent's line (owner, 7 Nov: "I couldn't hear myself ... only one-way. Make sure it
// doesn't happen anymore"). While a call is up it reads the browser's own WebRTC numbers every two seconds and
// says, on screen and in the web log, which side has gone quiet, instead of the agent finding out from the
// customer. It repairs what can be repaired without dropping the customer:
// - the line still muted from an earlier call (the nailed-up line outlives calls): unmuted at the start of a call;
// - the microphone track ended (headset unplugged, device switched): a fresh microphone is put on the line.
// What it cannot repair (no packets arriving from the server, the OS or headset muting the mic) it reports.
import { useEffect, useRef } from "react";

export type AudioProblem = "was-muted" | "mic-ended" | "mic-muted" | "mic-silent" | "not-sending" | "not-receiving";

interface CallLike {
  isMuted?: boolean;
  unmute?: () => void;
}

/** The jssip session's RTCPeerConnection behind a JambonzCall (a private field; null when not there). */
function peerOf(call: unknown): RTCPeerConnection | null {
  const s = (call as { session?: { connection?: RTCPeerConnection | null } } | null)?.session;
  return s?.connection ?? null;
}

interface Sample {
  sent: number;
  received: number;
  micLevel: number | null;
}

async function sample(pc: RTCPeerConnection): Promise<Sample> {
  const out: Sample = { sent: 0, received: 0, micLevel: null };
  const stats = await pc.getStats();
  stats.forEach((r: { type?: string; kind?: string; mediaType?: string; packetsSent?: number; packetsReceived?: number; audioLevel?: number }) => {
    const audio = r.kind === "audio" || r.mediaType === "audio";
    if (r.type === "outbound-rtp" && audio) out.sent += r.packetsSent ?? 0;
    if (r.type === "inbound-rtp" && audio) out.received += r.packetsReceived ?? 0;
    if (r.type === "media-source" && audio && typeof r.audioLevel === "number") out.micLevel = r.audioLevel;
  });
  return out;
}

/**
 * Watch the call on `callRef` while `active` (the main window, on a call). `onProblem` is called at most once
 * per problem per call; `message` is what the agent should read.
 */
export function useAudioWatchdog(opts: { callRef: { current: unknown }; active: boolean; callId: string | null; onProblem: (kind: AudioProblem, message: string, detail: Record<string, unknown>) => void }) {
  const { callRef, active, callId } = opts;
  const onProblemRef = useRef(opts.onProblem);
  useEffect(() => {
    onProblemRef.current = opts.onProblem;
  });

  useEffect(() => {
    if (!active || !callId) return;
    const said = new Set<AudioProblem>();
    const report = (kind: AudioProblem, message: string, detail: Record<string, unknown> = {}) => {
      if (said.has(kind)) return;
      said.add(kind);
      onProblemRef.current(kind, message, detail);
    };

    // A mute left on from the last call: the line is the same, so the mute is too.
    const call = callRef.current as CallLike | null;
    if (call?.isMuted && call.unmute) {
      call.unmute();
      report("was-muted", "Your microphone was still muted from the last call; it is unmuted now.");
    }

    let last: Sample | null = null;
    let stillSent = 0;
    let stillReceived = 0;
    let silentMic = 0;
    let mutedMic = 0;
    let repairing = false;
    let stopped = false;

    const tick = async () => {
      const c = callRef.current as CallLike | null;
      const pc = peerOf(c);
      if (!pc || stopped) return;
      const senders = pc.getSenders();
      const sender = senders.find((s) => s.track?.kind === "audio") ?? senders[0];
      const track = sender?.track ?? null;

      // The microphone went away (unplugged, switched device): put a fresh one on the line.
      if (sender && (!track || track.readyState === "ended") && !repairing) {
        repairing = true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const fresh = stream.getAudioTracks()[0];
          if (fresh) await sender.replaceTrack(fresh);
          report("mic-ended", "Your microphone dropped off the line; a fresh microphone was connected. If the customer still can't hear you, check your headset.", { repaired: Boolean(fresh) });
        } catch (e) {
          report("mic-ended", "Your microphone dropped off the line and could not be reconnected. Check your headset is plugged in and allowed in the browser.", { repaired: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          repairing = false;
        }
        return;
      }
      // The operating system or the headset's own switch is muting the microphone.
      if (track && track.muted) mutedMic += 1;
      else mutedMic = 0;
      if (mutedMic >= 3) report("mic-muted", "Your microphone is muted outside the browser (the headset's mute switch, or Windows/Mac sound settings). The customer can't hear you.");

      let s: Sample;
      try {
        s = await sample(pc);
      } catch {
        return;
      }
      const agentMuted = Boolean(c?.isMuted);
      if (last) {
        stillSent = s.sent === last.sent && !agentMuted ? stillSent + 1 : 0;
        stillReceived = s.received === last.received ? stillReceived + 1 : 0;
      }
      // Exactly zero is a microphone giving no signal at all; a quiet room is never exactly zero.
      silentMic = s.micLevel === 0 && !agentMuted ? silentMic + 1 : 0;
      last = s;

      if (stillSent >= 3) report("not-sending", "Your audio isn't leaving this computer, so the customer can't hear you. Check the microphone, then end the call and click Ready to reconnect the line.", { ...s });
      if (stillReceived >= 3) report("not-receiving", "No sound is reaching your headset from the call. End the call and click Ready to reconnect the line.", { ...s });
      if (silentMic >= 5) report("mic-silent", "We aren't hearing anything from your microphone. Check the right microphone is selected (browser address bar → microphone icon) and the headset isn't muted.", { ...s });
    };

    const t = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [active, callId, callRef]);
}
