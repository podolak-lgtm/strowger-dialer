/**
 * Inbound contact-center metrics, as pure maths over call facts, so the floor
 * wallboard, the Reports "Inbound" tab and the CSV export agree. Definitions:
 *
 * - offered: callers who entered the queue (a queue callback they asked for
 *   counts once, as the original call).
 * - answered: handed to an agent (bridged). abandoned: hung up while waiting.
 *   overflowed: neither (sent on to voicemail, another queue, or hung up by
 *   the queue at its limit).
 * - service level: answered within `slaSeconds` of entering, over offered.
 * - ASA: mean wait of answered calls. Abandon rate: abandoned over offered.
 * - AHT: mean talk (bridge to the agent's end) plus wrap (to the agent's
 *   disposition or the wrap-up timer).
 * - first-call resolution: answered calls with no other inbound call from the
 *   same number in the following `fcrDays` days.
 * - occupancy: time on calls and in wrap-up over time Ready + on calls + wrap,
 *   from the agents' state logs; idle is time Ready.
 */

export interface InboundFact {
  phone: string;
  /** When the caller entered the queue, ms. */
  queuedAt: number;
  bridgedAt: number | null;
  /** When the agent's part ended (the survey start, else the call end), ms. */
  talkEndedAt: number | null;
  wrapEndedAt: number | null;
  abandonedInQueue: boolean;
  /** Seconds waited before an agent took it (or before hanging up). */
  waitSeconds: number | null;
  surveyScore: number | null;
}

export interface InboundSummary {
  offered: number;
  answered: number;
  abandoned: number;
  overflowed: number;
  answeredWithinSla: number;
  serviceLevelPct: number;
  asaSeconds: number;
  abandonRatePct: number;
  ahtSeconds: number;
  talkSeconds: number;
  wrapSeconds: number;
  longestWaitSeconds: number;
  fcrPct: number;
  surveys: number;
  surveyAvg: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function waitOf(c: InboundFact): number {
  if (c.waitSeconds !== null) return c.waitSeconds;
  return c.bridgedAt ? Math.max(0, (c.bridgedAt - c.queuedAt) / 1000) : 0;
}

export function summarizeInbound(calls: readonly InboundFact[], opts: { slaSeconds: number; laterInbound?: ReadonlyArray<{ phone: string; at: number }>; fcrDays?: number }): InboundSummary {
  const answered = calls.filter((c) => c.bridgedAt !== null);
  const abandoned = calls.filter((c) => c.bridgedAt === null && c.abandonedInQueue);
  const within = answered.filter((c) => waitOf(c) <= opts.slaSeconds);
  const talk = answered.map((c) => (c.talkEndedAt && c.bridgedAt ? Math.max(0, (c.talkEndedAt - c.bridgedAt) / 1000) : 0));
  const wrap = answered.map((c) => (c.wrapEndedAt && c.talkEndedAt ? Math.max(0, (c.wrapEndedAt - c.talkEndedAt) / 1000) : 0));
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const fcrWindow = (opts.fcrDays ?? 7) * 86_400_000;
  const later = opts.laterInbound ?? [];
  const resolved = answered.filter((c) => !later.some((l) => l.phone === c.phone && l.at > c.queuedAt + 1000 && l.at - c.queuedAt <= fcrWindow));
  const surveys = calls.map((c) => c.surveyScore).filter((s): s is number => typeof s === "number" && s >= 1 && s <= 5);
  const offered = calls.length;
  return {
    offered,
    answered: answered.length,
    abandoned: abandoned.length,
    overflowed: offered - answered.length - abandoned.length,
    answeredWithinSla: within.length,
    serviceLevelPct: offered ? round1((within.length / offered) * 100) : 0,
    asaSeconds: answered.length ? Math.round(sum(answered.map(waitOf)) / answered.length) : 0,
    abandonRatePct: offered ? round1((abandoned.length / offered) * 100) : 0,
    ahtSeconds: answered.length ? Math.round((sum(talk) + sum(wrap)) / answered.length) : 0,
    talkSeconds: Math.round(sum(talk)),
    wrapSeconds: Math.round(sum(wrap)),
    longestWaitSeconds: Math.round(Math.max(0, ...calls.map(waitOf))),
    fcrPct: answered.length ? round1((resolved.length / answered.length) * 100) : 0,
    surveys: surveys.length,
    surveyAvg: surveys.length ? Math.round((sum(surveys) / surveys.length) * 100) / 100 : null,
  };
}

export interface StateEvent {
  state: string;
  at: number;
}

/** Seconds spent in each state between `from` and `to`, from a session's ordered state log starting at `start`. */
export function stateDurations(events: readonly StateEvent[], start: { state: string; at: number }, from: number, to: number): Record<string, number> {
  const timeline = [start, ...events].sort((a, b) => a.at - b.at);
  const out: Record<string, number> = {};
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i]!;
    const end = Math.min(to, timeline[i + 1]?.at ?? to);
    const begin = Math.max(from, cur.at);
    if (end > begin) out[cur.state] = (out[cur.state] ?? 0) + (end - begin) / 1000;
  }
  return out;
}

export function occupancy(d: Record<string, number>): { occupancyPct: number; idleSeconds: number; busySeconds: number } {
  const busy = (d.ON_CALL ?? 0) + (d.WRAP_UP ?? 0) + (d.RESERVED ?? 0);
  const idle = d.READY ?? 0;
  return { occupancyPct: busy + idle > 0 ? round1((busy / (busy + idle)) * 100) : 0, idleSeconds: Math.round(idle), busySeconds: Math.round(busy) };
}
