/**
 * Automatic call distribution, as pure functions the engine's queue tick
 * calls: which free agent a queue offers the next caller to (strategy), the
 * order callers are served in (priority + aging), which agents the outbound
 * pacer leaves alone for inbound (blending), and what a waiting caller is
 * told (position and estimated wait). Tested in distribution.test.ts.
 */

export const QUEUE_STRATEGIES = ["LONGEST_IDLE", "ROUND_ROBIN", "FEWEST_CALLS", "MOST_SKILLED"] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

export const STRATEGY_LABEL: Record<QueueStrategy, string> = {
  LONGEST_IDLE: "Longest idle: the agent free the longest",
  ROUND_ROBIN: "Round robin: each qualified agent in turn",
  FEWEST_CALLS: "Fewest calls: fewest inbound calls answered today",
  MOST_SKILLED: "Most skilled: highest skill rating, then longest idle",
};

export interface AgentCandidate {
  userId: string;
  /** When the agent entered their current (free) state, ms. Smaller = idle longer. */
  idleSince: number;
  /** Sum of the agent's levels on the queue's required skills (0 when the queue has none). */
  rating: number;
  /** Inbound calls this agent answered today. */
  callsToday: number;
}

/**
 * Order free, qualified agents for one queue. `lastServed` is the round-robin
 * pointer (the agent the queue gave its previous caller to): the rotation
 * starts with the next agent after it in a stable order.
 */
export function orderAgents<T extends AgentCandidate>(strategy: QueueStrategy, agents: readonly T[], lastServed: string | null = null): T[] {
  const byIdle = (a: T, b: T) => a.idleSince - b.idleSince || a.userId.localeCompare(b.userId);
  switch (strategy) {
    case "MOST_SKILLED":
      return [...agents].sort((a, b) => b.rating - a.rating || byIdle(a, b));
    case "FEWEST_CALLS":
      return [...agents].sort((a, b) => a.callsToday - b.callsToday || byIdle(a, b));
    case "ROUND_ROBIN": {
      const stable = [...agents].sort((a, b) => a.userId.localeCompare(b.userId));
      if (!lastServed) return stable;
      const next = stable.findIndex((a) => a.userId.localeCompare(lastServed) > 0);
      return next <= 0 ? stable : [...stable.slice(next), ...stable.slice(0, next)];
    }
    default:
      return [...agents].sort(byIdle);
  }
}

// ── Priority ────────────────────────────────────────────────────────────────

export interface PriorityRule {
  /** The queue's base priority. Higher is served first. */
  priority: number;
  /** Added when the caller's lead is flagged VIP. */
  vipPriority: number;
  /** Added when the caller matched a lead we know. */
  knownLeadPriority: number;
  /** One more point for every this many seconds waited; 0 = no aging. */
  agingSeconds: number;
}

export const PRIORITY_DEFAULTS: PriorityRule = { priority: 0, vipPriority: 10, knownLeadPriority: 2, agingSeconds: 60 };

/** The caller's priority when they enter the queue (aging comes on top while they wait). */
export function callerPriority(rule: PriorityRule, caller: { vip: boolean; knownLead: boolean }): number {
  return rule.priority + (caller.vip ? rule.vipPriority : 0) + (caller.knownLead ? rule.knownLeadPriority : 0);
}

/** Without aging a point outranks any difference in arrival (a point is worth ~11.6 days). */
const POINT_MS_NO_AGING = 1e9;

/**
 * The sorted-set score: lower is served first. It orders by priority, then by
 * arrival. With aging, a priority point is worth `agingSeconds` of waiting, so
 * the score is the caller's "virtual arrival": ordering by it is exactly
 * ordering by `effectivePriority` at any moment, ties by real arrival.
 */
export function queueScore(arrivalMs: number, priority: number, agingSeconds: number): number {
  const pointMs = agingSeconds > 0 ? agingSeconds * 1000 : POINT_MS_NO_AGING;
  return arrivalMs - priority * pointMs;
}

/** Priority now: entry priority plus one point per `agingSeconds` waited (continuous). */
export function effectivePriority(priority: number, arrivalMs: number, agingSeconds: number, now: number): number {
  return priority + (agingSeconds > 0 ? Math.max(0, now - arrivalMs) / (agingSeconds * 1000) : 0);
}

export interface WaitingHead {
  queueId: string;
  member: string;
  priority: number;
  arrivalMs: number;
  agingSeconds: number;
}

/**
 * An agent qualified for several queues takes the highest-priority waiting
 * caller across them (each queue offers its own head); ties go to whoever
 * arrived first.
 */
export function pickAcrossQueues<T extends WaitingHead>(heads: readonly T[], now: number): T | null {
  let best: T | null = null;
  let bestP = -Infinity;
  for (const h of heads) {
    const p = effectivePriority(h.priority, h.arrivalMs, h.agingSeconds, now);
    if (!best || p > bestP + 1e-9 || (Math.abs(p - bestP) <= 1e-9 && h.arrivalMs < best.arrivalMs)) {
      best = h;
      bestP = p;
    }
  }
  return best;
}

// ── Blending ────────────────────────────────────────────────────────────────

export interface BlendQueue {
  queueId: string;
  name: string;
  /** The queue's schedule is open (or it has none). */
  open: boolean;
  /** Seconds the oldest live caller has waited; null when nobody waits. */
  oldestWaitSeconds: number | null;
  /** Past this wait the pacer stops launching outbound calls for the queue's agents; 0 = never. */
  blendWaitSeconds: number;
  /** Qualified agents always kept out of the outbound pool while the queue is open. */
  reserveAgents: number;
  /** Logged-in agents qualified for the queue, the ones to reserve first at the front. */
  qualified: readonly string[];
}

export interface BlendReason {
  queueId: string;
  name: string;
  kind: "waiting" | "reserve";
  agents: number;
}

export interface BlendHolds {
  agentIds: string[];
  reasons: BlendReason[];
}

/** Agents the ratio pacer must not dial for, and why (shown on the floor). */
export function blendHolds(queues: readonly BlendQueue[]): BlendHolds {
  const held = new Set<string>();
  const reasons: BlendReason[] = [];
  for (const q of queues) {
    if (!q.open || q.qualified.length === 0) continue;
    if (q.blendWaitSeconds > 0 && q.oldestWaitSeconds !== null && q.oldestWaitSeconds >= q.blendWaitSeconds) {
      q.qualified.forEach((id) => held.add(id));
      reasons.push({ queueId: q.queueId, name: q.name, kind: "waiting", agents: q.qualified.length });
      continue;
    }
    if (q.reserveAgents > 0) {
      const picked = q.qualified.slice(0, q.reserveAgents);
      picked.forEach((id) => held.add(id));
      reasons.push({ queueId: q.queueId, name: q.name, kind: "reserve", agents: picked.length });
    }
  }
  return { agentIds: [...held].sort(), reasons };
}

export function blendMessage(h: BlendHolds): string | null {
  if (h.agentIds.length === 0) return null;
  return `Inbound priority: holding outbound for ${h.agentIds.length} agent${h.agentIds.length === 1 ? "" : "s"}`;
}

// ── Announcements ───────────────────────────────────────────────────────────

/**
 * Estimated wait for a caller at `position` (1 = next), from the queue's
 * answers in the last hour: the mean gap between answers times the position.
 * With a single answer, that caller's own wait; with none, unknown (null).
 */
export function estimateWaitSeconds(input: { position: number; answers: ReadonlyArray<{ at: number; waitSeconds: number }>; now: number; windowMs?: number }): number | null {
  const windowMs = input.windowMs ?? 3_600_000;
  const recent = input.answers.filter((a) => input.now - a.at <= windowMs).sort((a, b) => a.at - b.at);
  if (input.position <= 0) return 0;
  if (recent.length === 0) return null;
  if (recent.length === 1) return Math.max(0, Math.round(recent[0]!.waitSeconds));
  const gap = (recent[recent.length - 1]!.at - recent[0]!.at) / 1000 / (recent.length - 1);
  return Math.max(0, Math.round(gap * input.position));
}

export function waitPhrase(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return "less than a minute";
  const m = Math.round(seconds / 60);
  return m === 1 ? "about one minute" : `about ${m} minutes`;
}

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** What the caller hears between hold music. */
export function announcementText(position: number, ewtSeconds: number | null, opts: { position: boolean; wait: boolean } = { position: true, wait: true }): string | null {
  const parts: string[] = [];
  if (opts.position && position > 0) parts.push(position <= 10 ? `You are ${ORDINAL[position]} in line.` : `There are ${position - 1} callers ahead of you.`);
  const w = opts.wait ? waitPhrase(ewtSeconds) : null;
  if (w) parts.push(`Your estimated wait is ${w}.`);
  if (parts.length === 0) return null;
  return `${parts.join(" ")} Thank you for holding.`;
}

/** Time for the next announcement: on entry, then every `everySeconds` after the last one. */
export function announcementDue(lastAt: number | null, now: number, everySeconds: number): boolean {
  if (lastAt === null) return true;
  return now - lastAt >= Math.max(15, everySeconds) * 1000;
}
