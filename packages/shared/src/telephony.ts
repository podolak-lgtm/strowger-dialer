// Pure call-path rules the engine applies (apps/engine/src/jambonz/routes.ts, jambonz/rooms.ts).
// HANDOFF "Call path hardening, engine (owner, 7 Nov)".

/** How many characters of the agent leg's call_sid go into its room name. */
export const LINE_ROOM_SID_CHARS = 8;

/**
 * The conference room that is one agent line: `agent-<userId>-<first 8 chars of the leg's call_sid>`. Each line
 * gets a room of its own, so a lead can never be sent into a stale room of the same name left over from an
 * older leg. No sid (should not happen): the legacy per-user name.
 */
export function agentLineRoom(userId: string, callSid: string | null | undefined): string {
  const part = (callSid ?? "").slice(0, LINE_ROOM_SID_CHARS);
  return part ? `agent-${userId}-${part}` : `agent-${userId}`;
}

// ── One agent, one line (owner, 7 Nov: hard rule) ────────────────────────────

export interface NewLineInput {
  /** The leg the agent's live state already points at is still up at jambonz. */
  oldAlive: boolean;
  /** The agent asked to move the line to this screen (`linetakeover:<userId>`, set by the takeover endpoint). */
  takeover: boolean;
  /** The agent has a call (currentCallId set): their line is never hung up under it. */
  onCall: boolean;
}

export type NewLineDecision = { accept: false; hangUpOld: false } | { accept: true; hangUpOld: boolean };

/**
 * A second softphone leg called in for an agent whose live state names another leg. The old leg gone: take the
 * new one. Old leg alive: refuse the new one (the other screen keeps the phone) unless the agent asked to take
 * the line over here, and never while they are on a call, so a call in progress is never dropped and the agent
 * never has two lines.
 */
export function newLineDecision(i: NewLineInput): NewLineDecision {
  if (!i.oldAlive) return { accept: true, hangUpOld: false };
  if (i.onCall || !i.takeover) return { accept: false, hangUpOld: false };
  return { accept: true, hangUpOld: true };
}

// ── Answering-machine detection on a lead leg ────────────────────────────────

export interface AmdInput {
  /** jambonz event type: amd_human_detected, amd_machine_detected, amd_tone_detected, … */
  type: string | undefined;
  /** The call has an agent and was answered: the lead already sits in the agent's room. */
  joined: boolean;
  /** The call was abandoned (no agent free): the safe-harbor message is playing. */
  abandoned: boolean;
  voicemailAction: "HANGUP" | "DROP" | string;
  /** A machine verdict came earlier on this call (amdResult MACHINE). */
  machineSeen: boolean;
}

/**
 * What the AMD hook does. Every answered call joins the agent's room at once, so the hook never moves a lead
 * into a room (no rejoin, no second bridge):
 * - `none`: reply [] and leave the call where it is (human, no speech, timeout, errors, abandoned calls).
 * - `notify-machine`: reply [] and tell the agent (`call:update amd: machine`); they choose Leave VM.
 * - `hangup-voicemail`: a machine on a call nobody has joined, campaign set to HANGUP.
 * - `wait-for-tone`: a machine on a call nobody has joined, campaign set to DROP.
 * - `drop-voicemail`: the beep after a machine, campaign set to DROP: play the drop (with the conf-exit marker
 *   when the lead is in a room, so the old room's exit hook does not hang it up).
 */
export type AmdAction = "none" | "notify-machine" | "hangup-voicemail" | "wait-for-tone" | "drop-voicemail";

export function amdAction(i: AmdInput): AmdAction {
  if (i.abandoned) return "none";
  if (i.type === "amd_machine_detected") {
    if (i.joined) return "notify-machine";
    if (i.voicemailAction === "HANGUP") return "hangup-voicemail";
    if (i.voicemailAction === "DROP") return "wait-for-tone";
    return "none";
  }
  if (i.type === "amd_tone_detected") return i.voicemailAction === "DROP" && i.machineSeen ? "drop-voicemail" : "none";
  return "none";
}
