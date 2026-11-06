"use server";

import { prisma, type InboundRoute, type QueueAiMode, type QueueStrategy } from "@strowger/db";
import { AI_GREETING_MAX, AI_INSTRUCTIONS_MAX, AI_KNOWLEDGE_MAX, AI_LLM_VENDORS, AI_MAX_MINUTES_CAP, AI_MODES, DEFAULT_AI_MODEL, QUEUE_STRATEGIES, aiQueueConflict, holdConflict, parseHandoffPhrases, parseAreaCodes, parseHolidays, parseRangesText, parseStates, zonedTimeToUtc, type Holiday } from "@strowger/shared/inbound";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { transcriptionRefusal } from "@/lib/assist-readiness";

export type AiReadiness = { ok: boolean; problems: string[]; stt: string | null; tts: string | null };

/** What the jambonz account lacks before the AI answer may go on (engine: inbound/ai/control.ts). Null = the engine did not answer. */
export async function aiReadiness(v: { stt?: string | null; tts?: string | null; llm?: string | null } = {}): Promise<AiReadiness | null> {
  const qs = new URLSearchParams({ ...(v.stt ? { stt: v.stt } : {}), ...(v.tts ? { tts: v.tts } : {}), llm: v.llm || "anthropic" });
  try {
    return await engine<AiReadiness>(`/inbound/ai/readiness?${qs}`);
  } catch {
    return null;
  }
}

export type AiTestResult = { ok: true; opening: string; reply: string; tools: Array<{ name: string; input: unknown }>; handoffPhrase: string | null } | { ok: false; error: string };

/** The queue form's "Test the prompt": the form's AI fields as they are now, one caller line, the assistant's reply. */
export async function testAiPrompt(formData: FormData): Promise<AiTestResult> {
  const s = await sup();
  const line = str(formData, "testLine").slice(0, 1000);
  if (!line) return { ok: false, error: "Type what a caller might say." };
  const mode = AI_MODES.includes(str(formData, "aiMode") as (typeof AI_MODES)[number]) ? str(formData, "aiMode") : "FIRST";
  try {
    return await engine<AiTestResult>("/inbound/ai/test", {
      method: "POST",
      body: JSON.stringify({
        tenantId: s.tenant.id,
        queueName: str(formData, "name"),
        mode,
        greeting: opt(formData, "aiGreeting"),
        instructions: opt(formData, "aiInstructions")?.slice(0, AI_INSTRUCTIONS_MAX) ?? null,
        knowledge: opt(formData, "aiKnowledge")?.slice(0, AI_KNOWLEDGE_MAX) ?? null,
        handoffPhrases: str(formData, "aiHandoffPhrases").slice(0, 2000),
        model: str(formData, "aiModel") || DEFAULT_AI_MODEL,
        campaignId: opt(formData, "campaignId"),
        line,
      }),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sup() {
  return requireRole("SUPERVISOR");
}
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => str(fd, k) || null;
/** A whole number from the form, clamped; blank or junk gives the default. */
const int = (fd: FormData, k: string, def: number, min: number, max: number) => {
  const raw = str(fd, k);
  const n = raw === "" ? def : Math.round(Number(raw));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const on = (fd: FormData, k: string) => fd.get(k) === "on";

/** An id the form sent, kept only when it belongs to this tenant. */
async function own<T extends "queue" | "schedule" | "ivr" | "voicemailBox" | "callerIdNumber">(model: T, tenantId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const where = { id, tenantId };
  const hit =
    model === "queue"
      ? await prisma.queue.findFirst({ where, select: { id: true } })
      : model === "schedule"
        ? await prisma.schedule.findFirst({ where, select: { id: true } })
        : model === "ivr"
          ? await prisma.ivr.findFirst({ where, select: { id: true } })
          : model === "voicemailBox"
            ? await prisma.voicemailBox.findFirst({ where, select: { id: true } })
            : await prisma.callerIdNumber.findFirst({ where, select: { id: true } });
  return hit?.id ?? null;
}

export async function setNumberRoute(formData: FormData) {
  const s = await sup();
  const id = str(formData, "id");
  const routeTo = str(formData, "routeTo") as InboundRoute;
  const target = opt(formData, "target");
  const scheduleId = await own("schedule", s.tenant.id, opt(formData, "scheduleId"));
  await prisma.callerIdNumber.updateMany({
    where: { id, tenantId: s.tenant.id },
    data: { routeTo, ivrId: routeTo === "IVR" ? target : null, queueId: routeTo === "QUEUE" ? target : null, routeUserId: routeTo === "USER" ? target : null, scheduleId },
  });
  revalidatePath("/inbound");
}

// ── IVRs ──
export async function saveIvr(formData: FormData) {
  const s = await sup();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const options = [];
  for (let i = 0; i < 10; i++) {
    const action = str(formData, `opt${i}Action`);
    if (!action) continue;
    options.push({ digit: String(i), label: str(formData, `opt${i}Label`), action, targetId: opt(formData, `opt${i}Target`) });
  }
  const data = {
    tenantId: s.tenant.id,
    name,
    greetingAudioId: opt(formData, "greetingAudioId"),
    options,
    allowExtensions: formData.get("allowExtensions") === "on",
    timeoutSeconds: Math.max(2, Math.min(20, Number(formData.get("timeoutSeconds")) || 6)),
    repeats: Math.max(0, Math.min(5, Number(formData.get("repeats")) || 2)),
    timeoutAction: str(formData, "timeoutAction") || "HANGUP",
    timeoutTargetId: opt(formData, "timeoutTarget"),
  };
  if (id) await prisma.ivr.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.ivr.create({ data });
  revalidatePath("/inbound");
}

export async function deleteIvr(formData: FormData) {
  const s = await sup();
  const id = str(formData, "id");
  await prisma.callerIdNumber.updateMany({ where: { ivrId: id, tenantId: s.tenant.id }, data: { ivrId: null, routeTo: "CAMPAIGN" } });
  await prisma.ivr.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Queues ──
export async function saveQueue(formData: FormData) {
  const s = await sup();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const requiredSkills = formData
    .getAll("skillId")
    .map(String)
    .filter(Boolean)
    .map((skillId) => ({ skillId, minLevel: Math.max(1, Math.min(5, Number(formData.get(`minLevel_${skillId}`)) || 1)) }));
  const strategy = str(formData, "strategy") as QueueStrategy;
  const action = (k: string, def: string) => (["VOICEMAIL", "QUEUE", "HANGUP"].includes(str(formData, k)) ? str(formData, k) : def);
  const data = {
    tenantId: s.tenant.id,
    name,
    requiredSkills,
    campaignId: opt(formData, "campaignId"),
    holdAudioId: opt(formData, "holdAudioId"),
    maxWaitSeconds: int(formData, "maxWaitSeconds", 300, 15, 3600),
    overflowAction: action("overflowAction", "VOICEMAIL"),
    overflowQueueId: await own("queue", s.tenant.id, opt(formData, "overflowQueueId")),
    voicemailBoxId: await own("voicemailBox", s.tenant.id, opt(formData, "voicemailBoxId")),
    scheduleId: await own("schedule", s.tenant.id, opt(formData, "scheduleId")),
    // Distribution
    strategy: (QUEUE_STRATEGIES as readonly string[]).includes(strategy) ? strategy : "LONGEST_IDLE",
    stickySeconds: int(formData, "stickySeconds", 20, 0, 300),
    minHoldSeconds: int(formData, "minHoldSeconds", 0, 0, 600),
    minHoldBypassVip: on(formData, "minHoldBypassVip"),
    // Priority
    priority: int(formData, "priority", 0, -100, 100),
    vipPriority: int(formData, "vipPriority", 10, 0, 100),
    knownLeadPriority: int(formData, "knownLeadPriority", 2, 0, 100),
    agingSeconds: int(formData, "agingSeconds", 60, 0, 3600),
    // Announcements
    announce: on(formData, "announce"),
    announceEverySeconds: int(formData, "announceEverySeconds", 60, 15, 600),
    announcePosition: on(formData, "announcePosition"),
    announceWait: on(formData, "announceWait"),
    // Callback
    callbackEnabled: on(formData, "callbackEnabled"),
    callbackOfferAfterSeconds: int(formData, "callbackOfferAfterSeconds", 90, 10, 3600),
    callbackAudioId: opt(formData, "callbackAudioId"),
    // Blending
    blendWaitSeconds: int(formData, "blendWaitSeconds", 30, 0, 3600),
    reserveAgents: int(formData, "reserveAgents", 0, 0, 100),
    // Limits and wrap-up
    maxWaiting: int(formData, "maxWaiting", 0, 0, 1000),
    fullAction: action("fullAction", "VOICEMAIL"),
    wrapUpSeconds: int(formData, "wrapUpSeconds", 30, 0, 600),
    slaSeconds: int(formData, "slaSeconds", 20, 5, 600),
    // Survey
    surveyEnabled: on(formData, "surveyEnabled"),
    surveyAudioId: opt(formData, "surveyAudioId"),
    // Live transcription and assist (assist/live.ts in the engine)
    transcriptionOn: on(formData, "transcriptionOn"),
    liveAssistOn: on(formData, "liveAssistOn"),
    // AI answer
    aiEnabled: on(formData, "aiEnabled"),
    aiMode: (AI_MODES.includes(str(formData, "aiMode") as (typeof AI_MODES)[number]) ? str(formData, "aiMode") : "FIRST") as QueueAiMode,
    aiAfterSeconds: int(formData, "aiAfterSeconds", 60, 0, 3600),
    aiMaxMinutes: int(formData, "aiMaxMinutes", 10, 1, AI_MAX_MINUTES_CAP),
    aiGreeting: opt(formData, "aiGreeting")?.slice(0, AI_GREETING_MAX) ?? null,
    aiInstructions: opt(formData, "aiInstructions")?.slice(0, AI_INSTRUCTIONS_MAX) ?? null,
    aiKnowledge: opt(formData, "aiKnowledge")?.slice(0, AI_KNOWLEDGE_MAX) ?? null,
    aiHandoffPhrases: parseHandoffPhrases(str(formData, "aiHandoffPhrases")),
    aiSttVendor: opt(formData, "aiSttVendor")?.toLowerCase() ?? null,
    aiTtsVendor: opt(formData, "aiTtsVendor")?.toLowerCase() ?? null,
    aiVoice: opt(formData, "aiVoice"),
    aiLanguage: str(formData, "aiLanguage") || "en-US",
    aiLlmVendor: (AI_LLM_VENDORS as readonly string[]).includes(str(formData, "aiLlmVendor")) ? str(formData, "aiLlmVendor") : "anthropic",
    aiModel: str(formData, "aiModel") || DEFAULT_AI_MODEL,
  };
  const conflict = holdConflict(data) ?? aiQueueConflict(data);
  if (conflict) redirect(`/inbound?msg=${encodeURIComponent(`${name}: not saved. ${conflict}`)}&kind=error#queues`);
  // The AI answer goes on only when the jambonz account can carry it (speech-to-text above all): otherwise the rest
  // saves, the AI stays off, and the page says what to add in jambonz. A live call never finds it half set up.
  let aiRefused: string | null = null;
  if (data.aiEnabled) {
    const r = await aiReadiness({ stt: data.aiSttVendor, tts: data.aiTtsVendor, llm: data.aiLlmVendor });
    if (!r?.ok) {
      data.aiEnabled = false;
      aiRefused = `The AI answer was not turned on. ${r ? r.problems.join(" ") : "The engine did not answer, so the jambonz account could not be checked."}`;
    }
  }
  // Live transcription likewise: only with a speech-to-text vendor on the account.
  if (data.transcriptionOn) {
    const before = id ? await prisma.queue.findFirst({ where: { id, tenantId: s.tenant.id }, select: { transcriptionOn: true, liveAssistOn: true } }) : null;
    if (!before?.transcriptionOn || (data.liveAssistOn && !before.liveAssistOn)) {
      const refusal = await transcriptionRefusal({ assist: data.liveAssistOn });
      if (refusal) {
        data.transcriptionOn = before?.transcriptionOn ?? false;
        data.liveAssistOn = before?.liveAssistOn ?? false;
        aiRefused = [aiRefused, `Transcription was not switched on. ${refusal}`].filter(Boolean).join(" ");
      }
    }
  }
  if (id) await prisma.queue.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.queue.create({ data });
  revalidatePath("/inbound");
  if (aiRefused) redirect(`/inbound?msg=${encodeURIComponent(`${name}: saved, but not everything was turned on. ${aiRefused}`)}&kind=error#queues`);
}

export async function deleteQueue(formData: FormData) {
  const s = await sup();
  const id = str(formData, "id");
  await prisma.schedule.updateMany({ where: { tenantId: s.tenant.id, closedAction: "QUEUE", closedTargetId: id }, data: { closedAction: "MESSAGE", closedTargetId: null } });
  await prisma.callerIdNumber.updateMany({ where: { queueId: id, tenantId: s.tenant.id }, data: { queueId: null, routeTo: "CAMPAIGN" } });
  await prisma.queue.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Schedules (business hours) ──
export async function saveSchedule(formData: FormData) {
  const s = await sup();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const timezone = str(formData, "timezone") || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown time zone ${timezone}`);
  }
  const weekly: Record<string, Array<readonly [string, string]>> = {};
  for (let d = 0; d < 7; d++) {
    const ranges = parseRangesText(str(formData, `day${d}`));
    if (ranges.length) weekly[String(d)] = ranges;
  }
  const holidays: Holiday[] = [];
  for (const key of formData.keys()) {
    const m = /^holidayDate_(\w+)$/.exec(key);
    if (!m) continue;
    const date = str(formData, key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    holidays.push({ date, name: opt(formData, `holidayName_${m[1]}`), audioId: opt(formData, `holidayAudio_${m[1]}`) });
  }
  const closedAction = ["VOICEMAIL", "IVR", "QUEUE", "MESSAGE"].includes(str(formData, "closedAction")) ? str(formData, "closedAction") : "MESSAGE";
  const targetRaw = opt(formData, `closedTarget_${closedAction}`);
  const closedTargetId = closedAction === "QUEUE" ? await own("queue", s.tenant.id, targetRaw) : closedAction === "IVR" ? await own("ivr", s.tenant.id, targetRaw) : closedAction === "VOICEMAIL" ? await own("voicemailBox", s.tenant.id, targetRaw) : null;
  const untilRaw = str(formData, "closedUntil");
  const data = {
    tenantId: s.tenant.id,
    name,
    timezone,
    weekly,
    holidays: parseHolidays(holidays.sort((a, b) => a.date.localeCompare(b.date))) as unknown as object[],
    closedNow: on(formData, "closedNow"),
    // datetime-local is a wall clock: read in the schedule's own zone, like its hours.
    closedUntil: untilRaw ? zonedTimeToUtc(untilRaw, timezone) : null,
    closedNowAudioId: opt(formData, "closedNowAudioId"),
    closedAction,
    closedTargetId,
    closedGreetingAudioId: opt(formData, "closedGreetingAudioId"),
  };
  if (id) await prisma.schedule.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.schedule.create({ data });
  revalidatePath("/inbound");
}

export async function deleteSchedule(formData: FormData) {
  const s = await sup();
  const id = str(formData, "id");
  await prisma.queue.updateMany({ where: { scheduleId: id, tenantId: s.tenant.id }, data: { scheduleId: null } });
  await prisma.callerIdNumber.updateMany({ where: { scheduleId: id, tenantId: s.tenant.id }, data: { scheduleId: null } });
  await prisma.schedule.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

/** The "closed now" switch on its own, from the schedules list. */
export async function setClosedNow(formData: FormData) {
  const s = await sup();
  await prisma.schedule.updateMany({ where: { id: str(formData, "id"), tenantId: s.tenant.id }, data: { closedNow: str(formData, "closedNow") === "1", ...(str(formData, "closedNow") === "1" ? {} : { closedUntil: null }) } });
  revalidatePath("/inbound");
}

// ── Geographic routes ──
export async function saveGeoRoute(formData: FormData) {
  const s = await sup();
  const id = opt(formData, "id");
  const attach = str(formData, "attach"); // number:<id> | ivr:<id>
  const [kind, attachId] = attach.split(":") as [string, string | undefined];
  const numberId = kind === "number" ? await own("callerIdNumber", s.tenant.id, attachId ?? null) : null;
  const ivrId = kind === "ivr" ? await own("ivr", s.tenant.id, attachId ?? null) : null;
  const targetQueueId = await own("queue", s.tenant.id, opt(formData, "targetQueueId"));
  if (!numberId && !ivrId) throw new Error("Pick the number or IVR the rule belongs to");
  if (!targetQueueId) throw new Error("Pick the queue the rule sends callers to");
  const isFallback = on(formData, "isFallback");
  const states = parseStates(str(formData, "states"));
  const areaCodes = parseAreaCodes(str(formData, "areaCodes"));
  if (!isFallback && states.length === 0 && areaCodes.length === 0) throw new Error("Give states or area codes, or tick fallback");
  const data = { tenantId: s.tenant.id, name: str(formData, "name") || (isFallback ? "Everyone else" : [...states, ...areaCodes].join(", ")), numberId, ivrId, targetQueueId, isFallback, states: isFallback ? [] : states, areaCodes: isFallback ? [] : areaCodes, sortOrder: int(formData, "sortOrder", 0, 0, 999) };
  if (id) await prisma.geoRoute.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.geoRoute.create({ data });
  revalidatePath("/inbound");
}

export async function deleteGeoRoute(formData: FormData) {
  const s = await sup();
  await prisma.geoRoute.deleteMany({ where: { id: str(formData, "id"), tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Voicemail boxes ──
export async function saveBox(formData: FormData) {
  const s = await sup();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const data = { tenantId: s.tenant.id, name, ownerId: opt(formData, "ownerId"), greetingAudioId: opt(formData, "greetingAudioId"), notifyEmail: opt(formData, "notifyEmail") };
  if (id) await prisma.voicemailBox.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.voicemailBox.create({ data });
  revalidatePath("/inbound");
}

export async function deleteBox(formData: FormData) {
  const s = await sup();
  const id = str(formData, "id");
  await prisma.queue.updateMany({ where: { voicemailBoxId: id, tenantId: s.tenant.id }, data: { voicemailBoxId: null } });
  await prisma.voicemailBox.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Skills ──
export async function saveSkill(formData: FormData) {
  const s = await sup();
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  await prisma.skill.upsert({ where: { tenantId_name: { tenantId: s.tenant.id, name } }, create: { tenantId: s.tenant.id, name }, update: {} });
  revalidatePath("/skills");
}

export async function deleteSkill(formData: FormData) {
  const s = await sup();
  await prisma.skill.deleteMany({ where: { id: str(formData, "id"), tenantId: s.tenant.id } });
  revalidatePath("/skills");
}

/** Set one agent's level on one skill; 0 removes it. */
export async function setAgentSkill(formData: FormData) {
  const s = await sup();
  const userId = str(formData, "userId");
  const skillId = str(formData, "skillId");
  const level = Math.max(0, Math.min(5, Number(formData.get("level")) || 0));
  const [u, k] = await Promise.all([prisma.user.findFirst({ where: { id: userId, tenantId: s.tenant.id }, select: { id: true } }), prisma.skill.findFirst({ where: { id: skillId, tenantId: s.tenant.id }, select: { id: true } })]);
  if (!u || !k) throw new Error("Unknown person or skill");
  if (level === 0) await prisma.agentSkill.deleteMany({ where: { userId, skillId } });
  else await prisma.agentSkill.upsert({ where: { userId_skillId: { userId, skillId } }, create: { userId, skillId, level }, update: { level } });
  revalidatePath("/skills");
}

export async function setExtension(formData: FormData) {
  const s = await sup();
  const userId = str(formData, "userId");
  const ext = str(formData, "extension").replace(/\D/g, "").slice(0, 5) || null;
  if (ext) {
    const clash = await prisma.user.findFirst({ where: { tenantId: s.tenant.id, extension: ext, id: { not: userId } }, select: { id: true } });
    if (clash) throw new Error(`Extension ${ext} is taken`);
  }
  await prisma.user.updateMany({ where: { id: userId, tenantId: s.tenant.id }, data: { extension: ext } });
  revalidatePath("/skills");
  revalidatePath(`/people/${userId}`);
}

// ── Voicemails ──
export async function setVoicemailStatus(formData: FormData) {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const id = str(formData, "id");
  const status = str(formData, "status") as "NEW" | "LISTENED" | "DONE";
  await prisma.voicemail.updateMany({ where: { id, tenantId: s.tenant.id }, data: { status } });
  revalidatePath("/voicemails");
}

/** The agent's own voicemail alert preference and mobile number. */
export async function saveVoicemailPrefs(formData: FormData) {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const mobile = String(formData.get("mobilePhone") ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1") || null;
  await prisma.user.update({ where: { id: s.user.id }, data: { mobilePhone: mobile, notifyVoicemailSms: formData.get("notifyVoicemailSms") === "on" } });
  revalidatePath("/voicemails");
}
