// Post-call survey (per queue, off by default). When the agent ends an
// inbound queue call, the caller's leg is not hung up: it is REST-redirected
// to `/jambonz/survey`, which asks for 1 to 5. jambonz also runs the old
// room's conference actionHook (`/jambonz/conf-exit`) after a redirect, and
// that answer can win (the same race as transfers, HANDOFF "External
// transfers"), so conf-exit answers with the same survey verbs while the
// `survey:<callId>` flag is set. The agent goes to wrap-up at once.
//
// NOT YET EXERCISED LIVE: which of the two answers jambonz keeps, and whether
// the caller can hear the prompt twice, is unverified. Leave it off until a
// test call says otherwise.
import { prisma } from "@strowger/db";
import { getAgent } from "../agents/state";
import { hookUrl, jambonz } from "../jambonz/client";
import { log } from "../log";
import { redis } from "../redis";
import { emitToAgent } from "../realtime";
import { gatherPrompt, promptVerb, type Verbs } from "./common";
import { wrapAfterQueueCall } from "./queues";

const FLAG = (callId: string) => `survey:${callId}`;
const SURVEY_TEXT = "Before you go, how did we do today? Press 1 to 5, where 5 is excellent.";

/** True when the agent's hang-up was turned into the survey (the caller stays on the line). */
export async function startSurveyInsteadOfHangup(callId: string): Promise<boolean> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: { select: { surveyEnabled: true } } } });
  if (!call?.queue?.surveyEnabled || !call.providerCallId || call.endedAt || !call.bridgedAt || call.surveyStartedAt) return false;
  if (call.direction !== "INBOUND") return false;
  await redis.set(FLAG(callId), "1", "EX", 600);
  await prisma.call.update({ where: { id: callId }, data: { surveyStartedAt: new Date() } });
  try {
    await jambonz.calls.redirect(call.providerCallId, { url: hookUrl("/jambonz/survey", { callId }), method: "POST" });
  } catch (e) {
    log.warn({ err: e, callId }, "survey redirect failed; hanging up as usual");
    await redis.del(FLAG(callId));
    await prisma.call.update({ where: { id: callId }, data: { surveyStartedAt: null } });
    return false;
  }
  log.info({ callId }, "agent left; caller sent to the post-call survey");
  // The caller's leg stays up, so no status hook ends the call for the agent: end it for them now.
  if (call.agentId) {
    const agent = await getAgent(call.agentId);
    if (agent?.currentCallId === callId) await wrapAfterQueueCall(call);
    emitToAgent(call.agentId, "call:update", { callId, status: "ended", outcome: "BRIDGED", survey: true });
  }
  return true;
}

export async function surveyPending(callId: string): Promise<boolean> {
  return Boolean(await redis.get(FLAG(callId)));
}

export async function surveyVerbs(callId: string): Promise<Verbs> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { queue: { select: { surveyAudioId: true } } } });
  if (!call) return [{ verb: "hangup" }];
  const prompt = await gatherPrompt(call.queue?.surveyAudioId, SURVEY_TEXT);
  if (!("play" in prompt) && !("say" in prompt)) return [{ verb: "hangup" }]; // nothing to ask with (speech down, no recording)
  return [{ verb: "gather", input: ["digits"], numDigits: 1, timeout: 8, actionHook: hookUrl("/jambonz/survey-result", { callId }), ...prompt }, { verb: "hangup" }];
}

export async function surveyResult(callId: string, digits: string): Promise<Verbs> {
  await redis.del(FLAG(callId));
  const score = Number(digits);
  if (Number.isInteger(score) && score >= 1 && score <= 5) {
    await prisma.call.updateMany({ where: { id: callId }, data: { surveyScore: score } });
    log.info({ callId, score }, "survey answered");
  }
  const thanks = await promptVerb(null, "Thank you. Goodbye.");
  return [...(thanks ? [thanks] : []), { verb: "hangup" }];
}
