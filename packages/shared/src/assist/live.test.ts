import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRANSCRIPT_MAX_TURNS,
  aiSummaryBlocks,
  aiSummaryNote,
  appendTurn,
  assistAllowed,
  assistModel,
  clampAssistLimits,
  isFiller,
  keepAiSummaries,
  minutesOf,
  pickSuggestedDisposition,
  readTranscript,
  transcriptionReadiness,
  type TranscriptTurn,
} from "./live";

test("transcript is capped by turns and characters, oldest first", () => {
  let t: TranscriptTurn[] = [];
  for (let i = 0; i < TRANSCRIPT_MAX_TURNS + 10; i++) t = appendTurn(t, { speaker: i % 2 ? "AGENT" : "CUSTOMER", text: `turn ${i}`, at: i });
  assert.equal(t.length, TRANSCRIPT_MAX_TURNS);
  assert.equal(t[0]!.text, "turn 10");
  const big = appendTurn([{ speaker: "AGENT", text: "x".repeat(1000), at: 1 }], { speaker: "CUSTOMER", text: "y".repeat(5000), at: 2 });
  assert.equal(big.at(-1)!.text.length, 2000);
  assert.deepEqual(appendTurn(null, { speaker: "AGENT", text: "   ", at: 1 }), []);
  let many: TranscriptTurn[] = [];
  for (let i = 0; i < 100; i++) many = appendTurn(many, { speaker: "AGENT", text: "z".repeat(1500), at: i });
  assert.ok(many.reduce((n, x) => n + x.text.length, 0) <= 60_000);
});

test("readTranscript drops anything malformed", () => {
  assert.deepEqual(readTranscript(null), []);
  assert.deepEqual(readTranscript([{ speaker: "AGENT", text: "hi", at: 1 }, { speaker: "BOT", text: "x", at: 2 }, "junk"]), [{ speaker: "AGENT", text: "hi", at: 1 }]);
});

test("fillers and short utterances never trigger assist", () => {
  assert.equal(isFiller("yeah"), true);
  assert.equal(isFiller("uh huh okay"), true);
  assert.equal(isFiller("yes yes yes sure"), true);
  assert.equal(isFiller("not right now"), false);
  assert.equal(isFiller("I already have solar"), false);
});

test("assist rate limits: per-call cap and minimum gap", () => {
  const l = { minGapSeconds: 8, maxPerCall: 2 };
  assert.deepEqual(assistAllowed({ lastAt: null, used: 0 }, l, 1000), { ok: true });
  assert.deepEqual(assistAllowed({ lastAt: 1000, used: 1 }, l, 5000), { ok: false, reason: "too_soon" });
  assert.deepEqual(assistAllowed({ lastAt: 1000, used: 1 }, l, 9000), { ok: true });
  assert.deepEqual(assistAllowed({ lastAt: 1000, used: 2 }, l, 99_000), { ok: false, reason: "per_call_cap" });
  assert.deepEqual(clampAssistLimits(0, 1000), { minGapSeconds: 2, maxPerCall: 200 });
  assert.deepEqual(clampAssistLimits(Number.NaN, Number.NaN), { minGapSeconds: 8, maxPerCall: 40 });
  assert.equal(assistModel(""), "claude-haiku-5-5");
  assert.equal(assistModel("claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(assistModel("gpt-9"), "claude-haiku-5-5");
});

test("readiness refuses without an STT vendor and names the jambonz step", () => {
  const none = transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "cartesia", stt: false }] });
  assert.equal(none.ok, false);
  assert.match(none.problems[0]!, /Account → Speech services/);
  assert.match(none.problems[0]!, /Use for speech-to-text/);
  assert.equal(transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "google", stt: true }, { vendor: "deepgram", stt: true }] }).stt, "deepgram");
  // A voice-only vendor ticked for speech-to-text is never used (6 Nov: Cartesia broke two calls).
  const cartesiaOnly = transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "cartesia", stt: true }] });
  assert.equal(cartesiaOnly.ok, false);
  assert.equal(cartesiaOnly.stt, null);
  assert.equal(transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "cartesia", stt: true }, { vendor: "deepgram", stt: true }] }).stt, "deepgram");
  assert.equal(transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "google", stt: true }] }).stt, "google");
  assert.equal(transcriptionReadiness({ jambonzConfigured: true, creds: [{ vendor: "google", stt: true }], preferred: "deepgram" }).ok, false);
  assert.equal(transcriptionReadiness({ jambonzConfigured: false, creds: null }).ok, false);
  assert.equal(transcriptionReadiness({ jambonzConfigured: true, creds: null }).ok, false);
});

test("AI summary notes are appended, marked and kept through an autosave", () => {
  const at = new Date("2026-11-06T14:05:00Z");
  const n = aiSummaryNote("Called twice.", "Owner wants a callback Monday.", at);
  assert.equal(n, "Called twice.\n\nAI summary (6 Nov 2026 14:05 UTC): Owner wants a callback Monday.");
  assert.equal(aiSummaryNote("", "x", at), "AI summary (6 Nov 2026 14:05 UTC): x");
  assert.deepEqual(aiSummaryBlocks(n), ["AI summary (6 Nov 2026 14:05 UTC): Owner wants a callback Monday."]);
  // The agent's box still held "Called twice." when it saved: the summary stays.
  assert.equal(keepAiSummaries(n, "Called twice. Spoke to wife."), "Called twice. Spoke to wife.\n\nAI summary (6 Nov 2026 14:05 UTC): Owner wants a callback Monday.");
  // A box that already has it is saved as typed.
  assert.equal(keepAiSummaries(n, `${n}\nmore`), `${n}\nmore`);
  assert.equal(keepAiSummaries(null, "plain"), "plain");
});

test("suggested disposition maps to the campaign's own codes", () => {
  const list = [
    { id: "1", code: "SALE", label: "Sale" },
    { id: "2", code: "NI", label: "Not interested" },
  ];
  assert.equal(pickSuggestedDisposition(list, "ni")?.id, "2");
  assert.equal(pickSuggestedDisposition(list, "Not interested")?.id, "2");
  assert.equal(pickSuggestedDisposition(list, "DNC"), null);
  assert.equal(pickSuggestedDisposition(list, null), null);
});

test("minutes by the second", () => {
  assert.equal(minutesOf(90), 1.5);
  assert.equal(minutesOf(-3), 0);
  assert.equal(minutesOf(1), 0.0167);
});

test("partial lines while the suggestion streams", async () => {
  const { partialLines } = await import("./live");
  assert.deepEqual(partialLines(""), []);
  assert.deepEqual(partialLines('{"li'), []);
  assert.deepEqual(partialLines('{"lines":["Totally fair, most fo'), ["Totally fair, most fo"]);
  assert.deepEqual(partialLines('{"lines":["One \\"quoted\\" line.", "Two'), ['One "quoted" line.', "Two"]);
  assert.deepEqual(partialLines('{"lines":["A","B"],"tone":"calm"}'), ["A", "B"]);
});
