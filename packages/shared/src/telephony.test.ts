import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLineRoom, amdAction, newLineDecision, type AmdInput } from "./telephony";

test("each agent line has its own room: user id plus the first 8 characters of the leg's call_sid", () => {
  assert.equal(agentLineRoom("u1", "a1b2c3d4-e5f6-7788-99aa-bbccddeeff00"), "agent-u1-a1b2c3d4");
  assert.notEqual(agentLineRoom("u1", "a1b2c3d4-0000"), agentLineRoom("u1", "ffffffff-0000"));
  assert.equal(agentLineRoom("u1", null), "agent-u1");
  assert.equal(agentLineRoom("u1", ""), "agent-u1");
});

test("one line per agent: a second leg is refused while the first is up, unless the agent took the line over", () => {
  assert.deepEqual(newLineDecision({ oldAlive: false, takeover: false, onCall: false }), { accept: true, hangUpOld: false });
  assert.deepEqual(newLineDecision({ oldAlive: false, takeover: false, onCall: true }), { accept: true, hangUpOld: false });
  assert.deepEqual(newLineDecision({ oldAlive: true, takeover: false, onCall: false }), { accept: false, hangUpOld: false });
  assert.deepEqual(newLineDecision({ oldAlive: true, takeover: true, onCall: false }), { accept: true, hangUpOld: true });
});

test("a line with a call on it is never hung up, takeover or not", () => {
  assert.deepEqual(newLineDecision({ oldAlive: true, takeover: true, onCall: true }), { accept: false, hangUpOld: false });
  assert.deepEqual(newLineDecision({ oldAlive: true, takeover: false, onCall: true }), { accept: false, hangUpOld: false });
});

const base: AmdInput = { type: "amd_human_detected", joined: true, abandoned: false, voicemailAction: "DROP", machineSeen: false };

test("AMD never rejoins or re-bridges: human, no speech and timeout leave the call where it is", () => {
  for (const type of ["amd_human_detected", "amd_no_speech_detected", "amd_decision_timeout", "amd_error", undefined]) {
    for (const joined of [true, false]) assert.equal(amdAction({ ...base, type, joined }), "none", `${type} joined=${joined}`);
  }
});

test("a machine on a joined call is the agent's decision; the hang-up policy only applies before anyone joined", () => {
  assert.equal(amdAction({ ...base, type: "amd_machine_detected", voicemailAction: "HANGUP" }), "notify-machine");
  assert.equal(amdAction({ ...base, type: "amd_machine_detected", voicemailAction: "DROP" }), "notify-machine");
  assert.equal(amdAction({ ...base, type: "amd_machine_detected", joined: false, voicemailAction: "HANGUP" }), "hangup-voicemail");
  assert.equal(amdAction({ ...base, type: "amd_machine_detected", joined: false, voicemailAction: "DROP" }), "wait-for-tone");
});

test("the beep drops the voicemail only after a machine verdict, on a DROP campaign", () => {
  assert.equal(amdAction({ ...base, type: "amd_tone_detected", machineSeen: true }), "drop-voicemail");
  assert.equal(amdAction({ ...base, type: "amd_tone_detected", joined: false, machineSeen: true }), "drop-voicemail");
  assert.equal(amdAction({ ...base, type: "amd_tone_detected", machineSeen: false }), "none");
  assert.equal(amdAction({ ...base, type: "amd_tone_detected", machineSeen: true, voicemailAction: "HANGUP" }), "none");
});

test("an abandoned call is left alone whatever AMD says", () => {
  for (const type of ["amd_human_detected", "amd_machine_detected", "amd_tone_detected"]) assert.equal(amdAction({ ...base, type, abandoned: true, machineSeen: true }), "none");
});
