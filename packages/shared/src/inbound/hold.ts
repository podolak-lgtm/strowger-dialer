/**
 * Forced hold (owner, 6 Nov): a queue may make callers wait at least
 * `minHoldSeconds` before any agent is offered the call, because a share of
 * callers hang up in the first minutes and that lowers the cost of service.
 * Announcements, hold music, the callback offer and overflow carry on as
 * configured; only the offer to an agent waits.
 *
 * The hold is counted from when the caller first entered a queue (an
 * overflow into a second queue does not start it again). VIP leads skip it
 * when the queue says so, and callers who already waited or talked (a queue
 * callback, a hand-off from the AI answer) are never held.
 */

export interface HoldInput {
  /** When the caller first entered a queue, ms. */
  queuedAt: number;
  minHoldSeconds: number;
  vip: boolean;
  bypassVip: boolean;
  /** Back from a queue callback or an AI hand-off: no hold. */
  exempt?: boolean;
}

/** The moment the caller may first be offered to an agent, or null when there is no hold for them. */
export function forcedHoldUntil(h: HoldInput): number | null {
  if (h.exempt) return null;
  const secs = Math.max(0, Math.round(h.minHoldSeconds));
  if (secs === 0) return null;
  if (h.vip && h.bypassVip) return null;
  return h.queuedAt + secs * 1000;
}

/** Still inside the forced hold at `now`. */
export function inForcedHold(holdUntil: number | null | undefined, now: number): boolean {
  return typeof holdUntil === "number" && now < holdUntil;
}

/**
 * Seconds the caller has waited since they became answerable (the end of the
 * forced hold, else arrival); null while still in the forced hold. Blending
 * counts from here, so outbound is not held back for callers nobody may
 * answer yet.
 */
export function answerableWaitSeconds(arrivalMs: number, holdUntil: number | null | undefined, now: number): number | null {
  if (inForcedHold(holdUntil, now)) return null;
  const from = typeof holdUntil === "number" ? Math.max(arrivalMs, holdUntil) : arrivalMs;
  return Math.max(0, (now - from) / 1000);
}

/** The oldest answerable wait among callers, null when none is answerable yet. */
export function oldestAnswerableWait(callers: ReadonlyArray<{ arrivalMs: number; holdUntil?: number | null }>, now: number): number | null {
  let best: number | null = null;
  for (const c of callers) {
    const w = answerableWaitSeconds(c.arrivalMs, c.holdUntil ?? null, now);
    if (w !== null && (best === null || w > best)) best = w;
  }
  return best;
}

/** A queue's overflow must not fire before the hold ends: max wait has to be at least the forced hold. */
export function holdConflict(q: { minHoldSeconds: number; maxWaitSeconds: number }): string | null {
  if (q.minHoldSeconds > 0 && q.maxWaitSeconds < q.minHoldSeconds) {
    return `Max wait (${q.maxWaitSeconds}s) must be at least the forced hold (${q.minHoldSeconds}s), or every caller would overflow before an agent could take them.`;
  }
  return null;
}
