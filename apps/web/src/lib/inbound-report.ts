// Inbound (ACD) report queries, shared by the Reports "Inbound" tab, its CSV
// exports and the floor wallboard. The maths is shared/inbound/metrics.ts.
import { prisma } from "@strowger/db";
import { occupancy, stateDurations, summarizeAi, summarizeInbound, type AiSummary, type InboundFact, type InboundSummary } from "@strowger/shared/inbound";
import { agentName, type ReportRange } from "./reports";

export type QueueReportRow = { queueId: string; name: string; slaSeconds: number } & InboundSummary & { callbacksRequested: number; callbacksDone: number; callbacksFailed: number; ai: AiSummary };

/** Calls the AI answer took in the range (by when it took them), for its own numbers: resolved, hand-offs, minutes, containment. */
async function aiCalls(tenantId: string, from: Date, to: Date, queueId?: string | null) {
  return prisma.call.findMany({ where: { tenantId, aiHandledAt: { gte: from, lte: to }, ...(queueId ? { queueId } : {}) }, select: { queueId: true, aiOutcome: true, aiSeconds: true } });
}
export type AgentInboundRow = { agentId: string; agent: string; answered: number; ahtSeconds: number; talkSeconds: number; wrapSeconds: number; occupancyPct: number; idleSeconds: number; busySeconds: number; surveyAvg: number | null };

export async function inboundCalls(r: ReportRange, queueId?: string | null) {
  return prisma.call.findMany({
    where: { tenantId: r.tenantId, queueId: queueId ? queueId : { not: null }, queuedAt: { gte: r.from, lte: r.to } },
    orderBy: { queuedAt: "asc" },
    include: { queue: { select: { name: true, slaSeconds: true } }, agent: { select: { email: true, firstName: true, lastName: true } }, lead: { select: { firstName: true, lastName: true, vip: true } } },
  });
}
export type InboundCallRow = Awaited<ReturnType<typeof inboundCalls>>[number];

/** The caller's original call is the offered one; the callback leg we dialled and the call that asked for it are not. */
export const isOffered = (c: Pick<InboundCallRow, "direction" | "outcome">) => c.direction === "INBOUND" && c.outcome !== "CANCELLED";

export function factOf(c: InboundCallRow): InboundFact {
  return {
    phone: c.phone,
    queuedAt: (c.queuedAt ?? c.dialedAt).getTime(),
    bridgedAt: c.bridgedAt?.getTime() ?? null,
    talkEndedAt: (c.surveyStartedAt ?? c.endedAt)?.getTime() ?? null,
    wrapEndedAt: c.wrapEndedAt?.getTime() ?? null,
    abandonedInQueue: c.abandonedInQueue,
    waitSeconds: c.waitSeconds,
    surveyScore: c.surveyScore,
    forcedHoldSeconds: c.forcedHoldSeconds,
    abandonedInForcedHold: c.abandonedInForcedHold,
  };
}

/** Inbound calls from these numbers after the range starts and up to `fcrDays` past its end, for first-call resolution. */
async function laterInbound(tenantId: string, phones: string[], from: Date, to: Date, fcrDays = 7) {
  if (phones.length === 0) return [];
  const rows = await prisma.call.findMany({ where: { tenantId, direction: "INBOUND", phone: { in: phones }, dialedAt: { gte: from, lte: new Date(to.getTime() + fcrDays * 86_400_000) } }, select: { phone: true, dialedAt: true } });
  return rows.map((x) => ({ phone: x.phone, at: x.dialedAt.getTime() }));
}

export async function inboundReport(r: ReportRange, queueId?: string | null) {
  const [calls, queues, callbacks, ai] = await Promise.all([
    inboundCalls(r, queueId),
    prisma.queue.findMany({ where: { tenantId: r.tenantId, ...(queueId ? { id: queueId } : {}) }, orderBy: { name: "asc" }, select: { id: true, name: true, slaSeconds: true } }),
    prisma.queueCallback.findMany({ where: { tenantId: r.tenantId, requestedAt: { gte: r.from, lte: r.to }, ...(queueId ? { queueId } : {}) }, select: { queueId: true, status: true } }),
    aiCalls(r.tenantId, r.from, r.to, queueId),
  ]);
  const offered = calls.filter(isOffered);
  // Answers include queue callbacks that connected (their leg is OUTBOUND with the queue on it).
  const handled = calls.filter((c) => c.bridgedAt && (isOffered(c) || c.direction === "OUTBOUND"));
  const later = await laterInbound(r.tenantId, [...new Set(handled.map((c) => c.phone))], r.from, r.to);
  const factsFor = (rows: InboundCallRow[]) => rows.filter((c) => isOffered(c) || (c.direction === "OUTBOUND" && c.bridgedAt)).map(factOf);
  const defaultSla = queues.length === 1 ? queues[0]!.slaSeconds : 20;
  const overall = summarizeInbound(factsFor(calls), { slaSeconds: defaultSla, laterInbound: later });
  const byQueue: QueueReportRow[] = queues.map((q) => {
    const mine = calls.filter((c) => c.queueId === q.id);
    const cbs = callbacks.filter((c) => c.queueId === q.id);
    return {
      queueId: q.id,
      name: q.name,
      slaSeconds: q.slaSeconds,
      ...summarizeInbound(factsFor(mine), { slaSeconds: q.slaSeconds, laterInbound: later }),
      callbacksRequested: cbs.length,
      callbacksDone: cbs.filter((c) => c.status === "DONE").length,
      callbacksFailed: cbs.filter((c) => c.status === "FAILED").length,
      ai: summarizeAi(ai.filter((c) => c.queueId === q.id)),
    };
  });

  // Agents: their inbound handling plus occupancy and idle time from their state logs over the range.
  const agentIds = [...new Set(handled.map((c) => c.agentId).filter((x): x is string => Boolean(x)))];
  const sessions = await prisma.agentSession.findMany({ where: { tenantId: r.tenantId, startedAt: { lte: r.to }, OR: [{ endedAt: null }, { endedAt: { gte: r.from } }] }, select: { userId: true, startedAt: true, endedAt: true, events: true, user: { select: { email: true, firstName: true, lastName: true } } } });
  const users = new Map<string, { email: string; firstName: string | null; lastName: string | null }>();
  for (const sRow of sessions) users.set(sRow.userId, sRow.user);
  for (const c of handled) if (c.agentId && c.agent) users.set(c.agentId, c.agent);
  const ids = [...new Set([...agentIds, ...sessions.map((x) => x.userId)])];
  const rangeEnd = Math.min(r.to.getTime(), Date.now());
  const agents: AgentInboundRow[] = ids
    .map((id) => {
      const mine = handled.filter((c) => c.agentId === id);
      const sum = summarizeInbound(mine.map(factOf), { slaSeconds: defaultSla });
      const durations: Record<string, number> = {};
      for (const sRow of sessions.filter((x) => x.userId === id)) {
        const events = ((sRow.events as Array<{ state: string; at: string }> | null) ?? []).map((e) => ({ state: e.state, at: new Date(e.at).getTime() })).filter((e) => !Number.isNaN(e.at));
        const end = Math.min(rangeEnd, sRow.endedAt?.getTime() ?? rangeEnd);
        const d = stateDurations(events, { state: "LOGGED_IN", at: sRow.startedAt.getTime() }, r.from.getTime(), end);
        for (const [k, v] of Object.entries(d)) durations[k] = (durations[k] ?? 0) + v;
      }
      const occ = occupancy(durations);
      return { agentId: id, agent: agentName(users.get(id) ?? null), answered: sum.answered, ahtSeconds: sum.ahtSeconds, talkSeconds: sum.talkSeconds, wrapSeconds: sum.wrapSeconds, occupancyPct: occ.occupancyPct, idleSeconds: occ.idleSeconds, busySeconds: occ.busySeconds, surveyAvg: sum.surveyAvg };
    })
    .sort((a, b) => b.answered - a.answered || a.agent.localeCompare(b.agent));
  const occ = occupancy({ READY: agents.reduce((n, a) => n + a.idleSeconds, 0), ON_CALL: agents.reduce((n, a) => n + a.busySeconds, 0) });
  return { calls, offered, overall, ai: summarizeAi(ai), byQueue, agents, callbacks: { requested: callbacks.length, done: callbacks.filter((c) => c.status === "DONE").length, failed: callbacks.filter((c) => c.status === "FAILED").length }, occupancyPct: occ.occupancyPct, idleSeconds: agents.reduce((n, a) => n + a.idleSeconds, 0) };
}

export type WallboardQueue = {
  queueId: string;
  name: string;
  open: boolean;
  closedReason: string | null;
  waiting: number;
  /** Of `waiting`, still in the forced hold. */
  inForcedHold: number;
  minHoldSeconds: number;
  callbacksWaiting: number;
  longestWaitSeconds: number;
  available: number;
  onCall: number;
  wrapUp: number;
  slaSeconds: number;
  today: Pick<InboundSummary, "offered" | "answered" | "serviceLevelPct" | "asaSeconds" | "abandonRatePct" | "ahtSeconds" | "abandonedInForcedHold">;
  /** AI answer today, and callers talking to it now. */
  ai: Pick<AiSummary, "handled" | "resolved" | "handoffs" | "containmentPct" | "avgAiMinutes"> & { now: number; enabled: boolean };
};
export type Wallboard = { queues: WallboardQueue[]; holdMessage: string | null; at: number | null };

type EngineLive = { at: number; queues: Array<Omit<WallboardQueue, "today" | "minHoldSeconds">>; holds: { message: string | null } } | null;

/** The floor's inbound section: the engine's live numbers per queue (refreshed every second) and today's from the calls. */
export async function wallboard(tenantId: string, live: EngineLive, since: Date): Promise<Wallboard> {
  const queues = await prisma.queue.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, slaSeconds: true, minHoldSeconds: true, aiEnabled: true } });
  if (queues.length === 0) return { queues: [], holdMessage: null, at: live?.at ?? null };
  const calls = await prisma.call.findMany({
    where: { tenantId, queueId: { not: null }, queuedAt: { gte: since } },
    select: { queueId: true, direction: true, outcome: true, phone: true, queuedAt: true, dialedAt: true, bridgedAt: true, endedAt: true, surveyStartedAt: true, wrapEndedAt: true, abandonedInQueue: true, waitSeconds: true, surveyScore: true, forcedHoldSeconds: true, abandonedInForcedHold: true },
  });
  const [aiToday, aiNow] = await Promise.all([
    aiCalls(tenantId, since, new Date()),
    prisma.call.groupBy({ by: ["queueId"], where: { tenantId, aiHandledAt: { not: null }, aiEndedAt: null, endedAt: null, dialedAt: { gte: new Date(Date.now() - 3 * 3_600_000) } }, _count: { _all: true } }),
  ]);
  const rows = queues.map((q) => {
    const l = live?.queues.find((x) => x.queueId === q.id);
    const a = summarizeAi(aiToday.filter((c) => c.queueId === q.id));
    const mine = calls.filter((c) => c.queueId === q.id && (isOffered(c) || (c.direction === "OUTBOUND" && c.bridgedAt)));
    const facts: InboundFact[] = mine.map((c) => ({ phone: c.phone, queuedAt: (c.queuedAt ?? c.dialedAt).getTime(), bridgedAt: c.bridgedAt?.getTime() ?? null, talkEndedAt: (c.surveyStartedAt ?? c.endedAt)?.getTime() ?? null, wrapEndedAt: c.wrapEndedAt?.getTime() ?? null, abandonedInQueue: c.abandonedInQueue, waitSeconds: c.waitSeconds, surveyScore: c.surveyScore, forcedHoldSeconds: c.forcedHoldSeconds, abandonedInForcedHold: c.abandonedInForcedHold }));
    const s = summarizeInbound(facts, { slaSeconds: q.slaSeconds });
    return {
      queueId: q.id,
      name: q.name,
      open: l?.open ?? true,
      closedReason: l?.closedReason ?? null,
      waiting: l?.waiting ?? 0,
      inForcedHold: l?.inForcedHold ?? 0,
      minHoldSeconds: q.minHoldSeconds,
      callbacksWaiting: l?.callbacksWaiting ?? 0,
      longestWaitSeconds: l?.longestWaitSeconds ?? 0,
      available: l?.available ?? 0,
      onCall: l?.onCall ?? 0,
      wrapUp: l?.wrapUp ?? 0,
      slaSeconds: q.slaSeconds,
      today: { offered: s.offered, answered: s.answered, serviceLevelPct: s.serviceLevelPct, asaSeconds: s.asaSeconds, abandonRatePct: s.abandonRatePct, ahtSeconds: s.ahtSeconds, abandonedInForcedHold: s.abandonedInForcedHold },
      ai: { handled: a.handled, resolved: a.resolved, handoffs: a.handoffs, containmentPct: a.containmentPct, avgAiMinutes: a.avgAiMinutes, now: aiNow.find((x) => x.queueId === q.id)?._count._all ?? 0, enabled: q.aiEnabled },
    };
  });
  return { queues: rows, holdMessage: live?.holds.message ?? null, at: live?.at ?? null };
}
