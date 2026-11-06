// Games: points bets between agents and poker runs, both switched on per
// campaign (owner, 5 Nov: "enable this at the campaign level"). Hooks are
// called from the dialer (a dial, a disposition); settlement of period bets,
// the weekly top-up and the auto-close of runs past their end run from the
// scheduler. Rules in @strowger/shared/games.
import { prisma } from "@strowger/db";
import { HAND_MAX, INSTANT_KINDS, WAGER_KINDS, WAGER_NOTE_MAX, WAGER_SHORT, betTopUps, bestHand, cardProgress, cardsEarned, clampOutcomesPerCard, handShort, type CardProgress, clampBetSettings, dayKey, daysLeft, dealCard, declinePlan, describeHand, earnsCard, handMakers, ledgerKind, periodKeyFor, rankStandings, runIsLive, wagerActions, weekKey, type HandRank, type PokerRule, type WagerKind } from "@strowger/shared/games";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";

/** Workspace defaults for new campaigns (Settings → Games). */
export interface GameDefaults {
  weeklyPoints: number;
  maxStake: number;
}
export const DEFAULT_GAMES: GameDefaults = { weeklyPoints: 10_000, maxStake: 5_000 };

export async function gameDefaults(tenantId: string): Promise<GameDefaults> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const g = ((t?.settings ?? {}) as { games?: Partial<GameDefaults> }).games ?? {};
  return { weeklyPoints: g.weeklyPoints ?? DEFAULT_GAMES.weeklyPoints, maxStake: g.maxStake ?? DEFAULT_GAMES.maxStake };
}

export interface CampaignGames {
  id: string;
  name: string;
  status: string;
  betsEnabled: boolean;
  weeklyPoints: number;
  maxStake: number;
}
const campaignGamesSelect = { id: true, name: true, status: true, betsEnabled: true, weeklyPoints: true, maxStake: true } as const;

async function campaignGames(tenantId: string, campaignId: string): Promise<CampaignGames> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId }, select: campaignGamesSelect });
  if (!c) throw new Error("Unknown campaign");
  return c;
}

const displayName = (u: { firstName: string | null; email: string } | null) => (u ? (u.firstName ?? u.email.split("@")[0]!) : "anyone");
const people = { proposer: { select: { firstName: true, email: true } }, accepter: { select: { firstName: true, email: true } } } as const;
const shortOf = (kind: string) => WAGER_SHORT[kind as WagerKind] ?? kind;

/** What `games:wager` carries: enough for the console's challenge notice and settlement toast. */
function wagerEvent(w: { id: string; campaignId: string | null; kind: string; stake: number; note: string | null; proposerId: string; accepterId: string | null; winnerId?: string | null; proposer: { firstName: string | null; email: string }; accepter: { firstName: string | null; email: string } | null }, status: string, extra: Record<string, unknown> = {}) {
  return { id: w.id, campaignId: w.campaignId, status, kind: w.kind, label: WAGER_KINDS[w.kind as WagerKind] ?? w.kind, short: shortOf(w.kind), stake: w.stake, note: w.note, proposerId: w.proposerId, proposer: displayName(w.proposer), accepterId: w.accepterId, accepter: displayName(w.accepter), winnerId: w.winnerId ?? null, ...extra };
}

async function credit(tenantId: string, userId: string, delta: number, reason: string, wagerId?: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { points: { increment: delta } } }),
    prisma.pointsLedger.create({ data: { tenantId, userId, delta, reason, wagerId } }),
  ]);
  emitToAgent(userId, "games:points", { delta, reason });
}

// ---- Campaign switches

/** Turn bets on or off for a campaign and set its allowance and stake cap. Switching on tops up
 *  every agent on the campaign who is below the allowance, so the first week is playable at once. */
export async function setCampaignBets(tenantId: string, campaignId: string, actorId: string, input: { betsEnabled: boolean; weeklyPoints: number; maxStake: number }): Promise<CampaignGames> {
  const before = await campaignGames(tenantId, campaignId);
  const { weeklyPoints, maxStake } = clampBetSettings(input);
  const c = await prisma.campaign.update({ where: { id: campaignId }, data: { betsEnabled: input.betsEnabled, weeklyPoints, maxStake }, select: campaignGamesSelect });
  await prisma.auditLog.create({ data: { tenantId, actorId, action: "games.bets", target: campaignId, before: { betsEnabled: before.betsEnabled, weeklyPoints: before.weeklyPoints, maxStake: before.maxStake }, after: { betsEnabled: c.betsEnabled, weeklyPoints, maxStake } } });
  if (c.betsEnabled && !before.betsEnabled) {
    const agents = await prisma.campaignAgent.findMany({ where: { campaignId, tenantId }, select: { user: { select: { id: true, points: true, active: true } } } });
    for (const t of betTopUps(agents.map((a) => a.user), weeklyPoints)) await credit(tenantId, t.userId, t.delta, betsTopUpReason(c.name, weeklyPoints));
  }
  emitToTenant(tenantId, "games:bets", { campaignId, campaign: c.name, betsEnabled: c.betsEnabled, weeklyPoints, maxStake });
  return c;
}

export const betsTopUpReason = (campaign: string, weeklyPoints: number) => `Bets on for ${campaign}: topped up to ${weeklyPoints.toLocaleString()}`;

/** The campaign page's single Save wrote the bets switch (and any top-ups) in its own transaction; tell the consoles. */
export async function announceCampaignBets(tenantId: string, campaignId: string, credits: { userId: string; delta: number; reason: string }[]): Promise<void> {
  const c = await campaignGames(tenantId, campaignId);
  for (const t of credits) emitToAgent(t.userId, "games:points", { delta: t.delta, reason: t.reason });
  emitToTenant(tenantId, "games:bets", { campaignId, campaign: c.name, betsEnabled: c.betsEnabled, weeklyPoints: c.weeklyPoints, maxStake: c.maxStake });
}

// ---- Bets

export async function proposeWager(tenantId: string, proposerId: string, campaignId: string, accepterId: string | null, kind: WagerKind, stake: number, note?: string) {
  const c = await campaignGames(tenantId, campaignId);
  if (!c.betsEnabled) throw new Error(`Bets are off for ${c.name}`);
  if (!(kind in WAGER_KINDS)) throw new Error("Unknown bet");
  if (!Number.isInteger(stake) || stake <= 0 || stake > c.maxStake) throw new Error(`Stake must be 1 to ${c.maxStake} points`);
  const me = await prisma.user.findFirst({ where: { id: proposerId, tenantId } });
  if (!me || me.points < stake) throw new Error("Not enough points");
  if (accepterId === proposerId) throw new Error("Bet someone else");
  if (accepterId && !(await prisma.user.findFirst({ where: { id: accepterId, tenantId, active: true }, select: { id: true } }))) throw new Error("Unknown agent");
  const w = await prisma.wager.create({ data: { tenantId, campaignId, proposerId, accepterId, kind, stake, note: note?.trim().slice(0, WAGER_NOTE_MAX) || null, period: periodKeyFor(kind) }, include: people });
  await credit(tenantId, proposerId, -stake, `Bet placed: ${WAGER_KINDS[kind]}`, w.id);
  emitToTenant(tenantId, "games:wager", wagerEvent(w, "OPEN"));
  return w;
}

export async function acceptWager(tenantId: string, userId: string, wagerId: string) {
  const w = await prisma.wager.findFirst({ where: { id: wagerId, tenantId, status: "OPEN" } });
  if (!w) throw new Error("That bet is gone");
  if (w.proposerId === userId) throw new Error("That is your own bet");
  if (w.accepterId && w.accepterId !== userId) throw new Error("That bet was offered to somebody else");
  if (w.campaignId) {
    const c = await campaignGames(tenantId, w.campaignId);
    if (!c.betsEnabled) throw new Error(`Bets are off for ${c.name}`);
  }
  const me = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!me || me.points < w.stake) throw new Error("Not enough points");
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "OPEN" }, data: { status: "ACCEPTED", accepterId: userId } });
  if (upd.count !== 1) throw new Error("Somebody beat you to it");
  await credit(tenantId, userId, -w.stake, `Bet accepted: ${WAGER_KINDS[w.kind as WagerKind]}`, w.id);
  const after = await prisma.wager.findUniqueOrThrow({ where: { id: w.id }, include: people });
  emitToTenant(tenantId, "games:wager", wagerEvent(after, "ACCEPTED"));
  return after;
}

export async function withdrawWager(tenantId: string, userId: string, wagerId: string) {
  const w = await prisma.wager.findFirst({ where: { id: wagerId, tenantId, status: "OPEN", proposerId: userId }, include: people });
  if (!w) throw new Error("Only an open bet of yours can be withdrawn");
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "OPEN" }, data: { status: "DECLINED", settledAt: new Date() } });
  if (upd.count !== 1) throw new Error("That bet was just taken");
  await credit(tenantId, w.proposerId, w.stake, "Bet withdrawn", w.id);
  emitToTenant(tenantId, "games:wager", wagerEvent(w, "DECLINED", { withdrawn: true }));
}

/** The challenged agent says no: DECLINED, and the proposer's stake goes back (rule: `declinePlan`). */
export async function declineWager(tenantId: string, userId: string, wagerId: string) {
  const w = await prisma.wager.findFirst({ where: { id: wagerId, tenantId }, include: people });
  if (!w) throw new Error("That bet is gone");
  const plan = declinePlan(w, userId);
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "OPEN", accepterId: userId }, data: { status: plan.status, settledAt: new Date() } });
  if (upd.count !== 1) throw new Error("That bet is gone");
  await credit(tenantId, plan.refundTo, plan.amount, `Declined by ${displayName(w.accepter)}: ${shortOf(w.kind)}`, w.id);
  emitToTenant(tenantId, "games:wager", wagerEvent(w, "DECLINED", { declined: true }));
}

async function settle(wagerId: string, winnerId: string | null): Promise<void> {
  const w = await prisma.wager.findUnique({ where: { id: wagerId }, include: people });
  if (!w || w.status !== "ACCEPTED" || !w.accepterId) return;
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "ACCEPTED" }, data: { status: "SETTLED", winnerId, settledAt: new Date() } });
  if (upd.count !== 1) return;
  const label = WAGER_KINDS[w.kind as WagerKind];
  if (winnerId) {
    await credit(w.tenantId, winnerId, w.stake * 2, `Won: ${label}`, w.id);
    // The loser's stake left at bet time; a zero row puts the loss in their purse history.
    const loserId = winnerId === w.proposerId ? w.accepterId : w.proposerId;
    const winnerName = displayName(winnerId === w.proposerId ? w.proposer : w.accepter);
    await credit(w.tenantId, loserId, 0, `Lost: ${shortOf(w.kind)} to ${winnerName} (${w.stake.toLocaleString()} staked)`, w.id);
  } else {
    await credit(w.tenantId, w.proposerId, w.stake, `Push: ${label}`, w.id);
    await credit(w.tenantId, w.accepterId, w.stake, `Push: ${label}`, w.id);
  }
  emitToTenant(w.tenantId, "games:wager", wagerEvent({ ...w, winnerId }, "SETTLED"));
}

/** An instant event for one agent on one campaign: settle every accepted "next …" bet of that kind they
 *  are party to on that campaign (bets from before campaigns, with no campaign, count on any). */
async function settleInstant(tenantId: string, campaignId: string, kind: WagerKind, userId: string): Promise<void> {
  const open = await prisma.wager.findMany({ where: { tenantId, kind, status: "ACCEPTED", OR: [{ campaignId }, { campaignId: null }], AND: [{ OR: [{ proposerId: userId }, { accepterId: userId }] }] } });
  for (const w of open) await settle(w.id, userId);
}

type Stat = "calls" | "contacts" | "sales";
async function statIn(tenantId: string, campaignId: string | null, userId: string, stat: Stat, since: Date, until: Date): Promise<number> {
  const base = { tenantId, agentId: userId, dialedAt: { gte: since, lt: until }, ...(campaignId ? { campaignId } : {}) };
  if (stat === "calls") return prisma.call.count({ where: { ...base, direction: "OUTBOUND" } });
  return prisma.call.count({ where: { ...base, disposition: stat === "sales" ? { isSale: true } : { isContact: true } } });
}

/** Period bets whose period has ended: compare the two stats on the bet's campaign, pay the winner, push on a tie. */
export async function settlePeriodWagers(now = new Date()): Promise<void> {
  const today = dayKey(now);
  const thisWeek = weekKey(now);
  const due = await prisma.wager.findMany({ where: { status: "ACCEPTED", period: { not: null }, NOT: [{ period: today }, { period: thisWeek }] } });
  for (const w of due) {
    const kind = w.kind as WagerKind;
    const stat: Stat = kind.startsWith("MOST_CALLS") ? "calls" : kind.startsWith("MOST_CONTACTS") ? "contacts" : "sales";
    const since = kind.endsWith("_WEEK") ? startOfIsoWeek(w.period!) : new Date(`${w.period}T00:00:00Z`);
    const until = kind.endsWith("_WEEK") ? new Date(since.getTime() + 7 * 86_400_000) : new Date(since.getTime() + 86_400_000);
    const [a, b] = await Promise.all([statIn(w.tenantId, w.campaignId, w.proposerId, stat, since, until), statIn(w.tenantId, w.campaignId, w.accepterId!, stat, since, until)]);
    await settle(w.id, a === b ? null : a > b ? w.proposerId : w.accepterId);
  }
  // Open (unaccepted) period bets past their period: refund.
  const stale = await prisma.wager.findMany({ where: { status: "OPEN", period: { not: null }, NOT: [{ period: today }, { period: thisWeek }] } });
  for (const w of stale) {
    await prisma.wager.update({ where: { id: w.id }, data: { status: "VOID", settledAt: now } });
    await credit(w.tenantId, w.proposerId, w.stake, "Bet expired, nobody took it", w.id);
  }
}
function startOfIsoWeek(key: string): Date {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() - (day - 1) * 86_400_000);
  return new Date(monday.getTime() + (w - 1) * 7 * 86_400_000);
}

/** Every Monday (UTC): each agent on at least one active campaign with bets on is set to the largest
 *  weekly allowance among those campaigns (points are per person, campaigns share the purse). */
export async function weeklyTopUp(now = new Date()): Promise<void> {
  const rows = await prisma.campaignAgent.findMany({ where: { campaign: { status: "ACTIVE", betsEnabled: true }, user: { active: true, roles: { hasSome: ["AGENT", "TEAM_LEADER"] } } }, select: { tenantId: true, userId: true, campaign: { select: { weeklyPoints: true } }, user: { select: { points: true } } } });
  const byUser = new Map<string, { tenantId: string; points: number; allowance: number }>();
  for (const r of rows) {
    const e = byUser.get(r.userId) ?? { tenantId: r.tenantId, points: r.user.points, allowance: 0 };
    e.allowance = Math.max(e.allowance, r.campaign.weeklyPoints);
    byUser.set(r.userId, e);
  }
  for (const [userId, e] of byUser) {
    const delta = e.allowance - e.points;
    if (delta !== 0) await credit(e.tenantId, userId, delta, `Monday top-up to ${e.allowance.toLocaleString()} (${weekKey(now)})`);
  }
}

// ---- Poker runs

export interface RunSummary {
  id: string;
  campaignId: string;
  campaign: string;
  name: string;
  prize: string | null;
  startsAt: string;
  endsAt: string;
  daysLeft: number;
  live: boolean;
  status: "ACTIVE" | "ENDED";
  qualifies: string;
  codes: string[];
  /** A card every N qualifying outcomes. */
  outcomesPerCard: number;
  /** Seven-card stud: cards a hand can hold. */
  handMax: number;
  /** Ranked by `rankStandings`: best hand, then cards held, then contacts; `place` shared only on a tie in all three.
   *  `outcomes` are qualifying outcomes in the run, `contacts` calls with a contact disposition in its window,
   *  `progress` toward the next card (the ring). */
  rows: { userId: string; name: string; cards: string[]; place: number; contacts: number; outcomes: number; progress: CardProgress; hand: { name: string; short: string; label: string; cards: string[]; makers: string[] } | null }[];
  winner: { userId: string; name: string; hand: string; cards: string[] } | null;
  endedAt: string | null;
}

type RunRow = NonNullable<Awaited<ReturnType<typeof prisma.pokerRun.findFirst>>>;

function ruleOf(run: { qualifies: string; qualifyingCodes: string[] }): PokerRule {
  const q = run.qualifies === "CONTACT" ? "CONTACT" : run.qualifies === "CODES" ? "CODES" : "SALE";
  return { qualifies: q, codes: run.qualifyingCodes };
}

type RunLike = { id: string; tenantId: string; campaignId: string; startsAt: Date; endsAt: Date; qualifies: string; qualifyingCodes: string[] };

/** The campaign's dispositions that deal a card under the run's rule (shared `earnsCard`). */
async function qualifyingDispositionIds(run: RunLike): Promise<string[]> {
  const ds = await prisma.disposition.findMany({ where: { campaignId: run.campaignId }, select: { id: true, code: true, isSale: true, isContact: true } });
  const rule = ruleOf(run);
  return ds.filter((d) => earnsCard(rule, d)).map((d) => d.id);
}

/** Calls of the run's campaign that belong to its window: dialled before it ends and dialled or ended after it starts. */
function runCalls(run: RunLike, agentId?: string) {
  return { tenantId: run.tenantId, campaignId: run.campaignId, ...(agentId ? { agentId } : { agentId: { not: null } }), dialedAt: { lt: run.endsAt }, OR: [{ dialedAt: { gte: run.startsAt } }, { endedAt: { gte: run.startsAt } }] };
}

/** Qualifying outcomes and contacts per agent in the run's window. */
async function runStats(run: RunLike): Promise<Map<string, { outcomes: number; contacts: number }>> {
  const ids = await qualifyingDispositionIds(run);
  const [q, c] = await Promise.all([
    ids.length ? prisma.call.groupBy({ by: ["agentId"], where: { ...runCalls(run), dispositionId: { in: ids } }, _count: { _all: true } }) : Promise.resolve([]),
    prisma.call.groupBy({ by: ["agentId"], where: { ...runCalls(run), disposition: { isContact: true } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { outcomes: number; contacts: number }>();
  for (const r of q) if (r.agentId) out.set(r.agentId, { outcomes: r._count._all, contacts: 0 });
  for (const r of c) if (r.agentId) out.set(r.agentId, { outcomes: out.get(r.agentId)?.outcomes ?? 0, contacts: r._count._all });
  return out;
}

async function standings(run: RunLike & { outcomesPerCard: number }) {
  const [cards, stats] = await Promise.all([prisma.pokerCard.findMany({ where: { runId: run.id }, include: { user: { select: { firstName: true, email: true } } }, orderBy: { dealtAt: "asc" } }), runStats(run)]);
  const byUser = new Map<string, { userId: string; name: string; cards: string[]; contacts: number; outcomes: number }>();
  for (const c of cards) {
    const e = byUser.get(c.userId) ?? { userId: c.userId, name: displayName(c.user), cards: [], contacts: 0, outcomes: 0 };
    e.cards.push(c.card);
    byUser.set(c.userId, e);
  }
  const missing = [...stats.keys()].filter((id) => !byUser.has(id));
  const users = missing.length ? await prisma.user.findMany({ where: { id: { in: missing }, tenantId: run.tenantId }, select: { id: true, firstName: true, email: true } }) : [];
  for (const u of users) byUser.set(u.id, { userId: u.id, name: displayName(u), cards: [], contacts: 0, outcomes: 0 });
  for (const [id, st] of stats) {
    const e = byUser.get(id);
    if (e) Object.assign(e, st);
  }
  return rankStandings([...byUser.values()]).map((r) => ({ ...r, progress: cardProgress(r.outcomes, run.outcomesPerCard, r.cards.length) }));
}

async function summarise(run: RunRow, campaignName: string, now = new Date()): Promise<RunSummary> {
  const rows = await standings(run);
  const wh = run.winningHand as RunSummary["winner"] | null;
  return {
    id: run.id,
    campaignId: run.campaignId,
    campaign: campaignName,
    name: run.name,
    prize: run.prize,
    startsAt: run.startsAt.toISOString(),
    endsAt: run.endsAt.toISOString(),
    daysLeft: daysLeft(run.endsAt, now),
    live: runIsLive(run, now),
    status: run.status,
    qualifies: run.qualifies,
    codes: run.qualifyingCodes,
    outcomesPerCard: run.outcomesPerCard,
    handMax: HAND_MAX,
    rows: rows.map((r) => ({ userId: r.userId, name: r.name, cards: r.cards, place: r.place, contacts: r.contacts, outcomes: r.outcomes, progress: r.progress, hand: r.hand ? { name: r.hand.name, short: handShort(r.hand), label: describeHand(r.hand), cards: r.hand.cards, makers: handMakers(r.hand) } : null })),
    winner: run.status === "ENDED" ? (wh ?? null) : null,
    endedAt: run.endedAt?.toISOString() ?? null,
  };
}

export async function activeRun(tenantId: string, campaignId: string) {
  return prisma.pokerRun.findFirst({ where: { tenantId, campaignId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
}

export async function startPokerRun(tenantId: string, campaignId: string, createdById: string, input: { name: string; startsAt: Date; endsAt: Date; prize: string | null; rule: PokerRule; outcomesPerCard?: number }): Promise<RunSummary> {
  const c = await campaignGames(tenantId, campaignId);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Give the run a name");
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) throw new Error("The run must end after it starts");
  if (input.endsAt.getTime() <= Date.now()) throw new Error("The run would already be over");
  if (await activeRun(tenantId, campaignId)) throw new Error(`${c.name} already has a poker run going; end it first`);
  const run = await prisma.pokerRun.create({
    data: { tenantId, campaignId, createdById, name, startsAt: input.startsAt, endsAt: input.endsAt, prize: input.prize?.trim().slice(0, 120) || null, qualifies: input.rule.qualifies, qualifyingCodes: input.rule.codes, outcomesPerCard: clampOutcomesPerCard(input.outcomesPerCard ?? 1) },
  });
  await prisma.auditLog.create({ data: { tenantId, actorId: createdById, action: "games.run.start", target: run.id, after: { campaignId, name, startsAt: run.startsAt, endsAt: run.endsAt, prize: run.prize, qualifies: run.qualifies, codes: run.qualifyingCodes, outcomesPerCard: run.outcomesPerCard } } });
  const summary = await summarise(run, c.name);
  emitToTenant(tenantId, "games:run", { status: "ACTIVE", campaignId, campaign: c.name, id: run.id, name: run.name, prize: run.prize, endsAt: summary.endsAt, daysLeft: summary.daysLeft });
  return summary;
}

/** End a run: rank every hand with the evaluator, record the winner, tell the floor. */
export async function endPokerRun(tenantId: string, runId: string, actorId: string | null): Promise<RunSummary> {
  const run = await prisma.pokerRun.findFirst({ where: { id: runId, tenantId }, include: { campaign: { select: { name: true } } } });
  if (!run) throw new Error("Unknown poker run");
  if (run.status === "ENDED") return summarise(run, run.campaign.name);
  const rows = await standings(run);
  const top = rows.find((r) => r.hand);
  const winningHand = top ? { userId: top.userId, name: top.name, hand: describeHand(top.hand!), cards: top.hand!.cards } : null;
  const upd = await prisma.pokerRun.updateMany({ where: { id: run.id, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), winnerId: top?.userId ?? null, winningHand: winningHand ?? undefined } });
  if (upd.count !== 1) return summarise((await prisma.pokerRun.findUniqueOrThrow({ where: { id: run.id } })) as RunRow, run.campaign.name);
  await prisma.auditLog.create({ data: { tenantId, actorId, action: "games.run.end", target: run.id, after: { winner: winningHand } } });
  const ended = await prisma.pokerRun.findUniqueOrThrow({ where: { id: run.id } });
  const summary = await summarise(ended, run.campaign.name);
  emitToTenant(tenantId, "games:run", { status: "ENDED", campaignId: run.campaignId, campaign: run.campaign.name, id: run.id, name: run.name, prize: run.prize, winner: winningHand });
  if (top) emitToAgent(top.userId, "games:won", { runId: run.id, name: run.name, prize: run.prize, hand: describeHand(top.hand!) });
  return summary;
}

/** Scheduler: runs past their end close themselves. */
export async function endExpiredRuns(now = new Date()): Promise<void> {
  const due = await prisma.pokerRun.findMany({ where: { status: "ACTIVE", endsAt: { lte: now } }, select: { id: true, tenantId: true } });
  for (const r of due) {
    try {
      await endPokerRun(r.tenantId, r.id, null);
    } catch (e) {
      log.warn({ err: e, runId: r.id }, "games: could not end poker run");
    }
  }
}

/** A disposition on a campaign with a live run (seven-card stud, owner 6 Nov): when it qualifies, count the agent's
 *  qualifying outcomes in the run and deal up to what they have earned (`cardsEarned`: one every N, seven at most).
 *  A full hand gets `games:full` instead. Returns the cards dealt. */
export async function dealForOutcome(tenantId: string, campaignId: string, userId: string, callId: string, outcome: { isSale: boolean; isContact: boolean; code: string }): Promise<string[]> {
  const run = await activeRun(tenantId, campaignId);
  if (!run || !runIsLive(run)) return [];
  if (!earnsCard(ruleOf(run), outcome)) return [];
  const ids = await qualifyingDispositionIds(run);
  const outcomes = ids.length ? await prisma.call.count({ where: { ...runCalls(run, userId), dispositionId: { in: ids } } }) : 0;
  const held = (await prisma.pokerCard.findMany({ where: { runId: run.id, userId }, select: { card: true } })).map((c) => c.card);
  const due = cardsEarned(outcomes, run.outcomesPerCard);
  const dealt: string[] = [];
  while (held.length < due) {
    const card = dealCard(held);
    if (!card) break;
    await prisma.pokerCard.create({ data: { tenantId, userId, runId: run.id, period: weekKey(), card, callId } });
    held.push(card);
    dealt.push(card);
    const hand = bestHand(held);
    emitToAgent(userId, "games:card", { card, runId: run.id, run: run.name, campaignId, hand: hand ? describeHand(hand) : null, held: held.length, handMax: HAND_MAX });
  }
  if (!dealt.length && held.length >= HAND_MAX) emitToAgent(userId, "games:full", { runId: run.id, run: run.name, campaignId, held: held.length, handMax: HAND_MAX });
  emitToTenant(tenantId, "games:poker", { userId, runId: run.id, campaignId });
  return dealt;
}

// ---- Hooks from the dialer

export async function onDialed(tenantId: string, campaignId: string, agentId: string): Promise<void> {
  try {
    await settleInstant(tenantId, campaignId, "NEXT_CALL", agentId);
  } catch (e) {
    log.warn({ err: e }, "games: dial hook failed");
  }
}

export async function onDispositioned(tenantId: string, campaignId: string, agentId: string, callId: string, outcome: { isSale: boolean; isContact: boolean; code: string }): Promise<void> {
  try {
    if (outcome.isContact) await settleInstant(tenantId, campaignId, "NEXT_CONTACT", agentId);
    if (outcome.isSale) await settleInstant(tenantId, campaignId, "NEXT_SALE", agentId);
    await dealForOutcome(tenantId, campaignId, agentId, callId, outcome);
  } catch (e) {
    log.warn({ err: e }, "games: disposition hook failed");
  }
}

// ---- What a person sees

/** Campaigns the person plays on: their assignments (scope "mine") or every campaign (managers, scope "all"); ACTIVE ones first. */
async function visibleCampaigns(tenantId: string, userId: string, scope: "mine" | "all") {
  const where = scope === "all" ? { tenantId, status: { in: ["ACTIVE", "PAUSED"] as ("ACTIVE" | "PAUSED")[] } } : { tenantId, status: "ACTIVE" as const, agents: { some: { userId } } };
  const list = await prisma.campaign.findMany({ where, select: campaignGamesSelect, orderBy: [{ status: "asc" }, { name: "asc" }] });
  return list;
}

export async function gamesOverview(tenantId: string, userId: string, scope: "mine" | "all", campaignId?: string | null) {
  const now = new Date();
  const campaigns = await visibleCampaigns(tenantId, userId, scope);
  const activeRuns = await prisma.pokerRun.findMany({ where: { tenantId, status: "ACTIVE", campaignId: { in: campaigns.map((c) => c.id) } } });
  const runByCampaign = new Map(activeRuns.map((r) => [r.campaignId, r]));
  const selected = campaigns.find((c) => c.id === campaignId) ?? campaigns.find((c) => c.betsEnabled || runByCampaign.has(c.id)) ?? campaigns[0] ?? null;

  const [me, ledger, dispositions] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, tenantId }, select: { points: true } }),
    prisma.pointsLedger.findMany({ where: { tenantId, userId }, orderBy: { createdAt: "desc" }, take: 15 }),
    selected ? prisma.disposition.findMany({ where: { campaignId: selected.id, active: true }, select: { code: true, label: true, isSale: true, isContact: true }, orderBy: { sortOrder: "asc" } }) : Promise.resolve([]),
  ]);
  const wagers = selected ? await prisma.wager.findMany({ where: { tenantId, status: { in: ["OPEN", "ACCEPTED"] }, OR: [{ campaignId: selected.id }, { campaignId: null }] }, orderBy: { createdAt: "desc" }, take: 50, include: people }) : [];
  // Recently settled: the campaign's (the floor likes to see who won) and mine anywhere.
  const settled = await prisma.wager.findMany({ where: { tenantId, status: "SETTLED", OR: [...(selected ? [{ campaignId: selected.id }] : []), { proposerId: userId }, { accepterId: userId }] }, orderBy: { settledAt: "desc" }, take: 10, include: people });
  const shape = (w: (typeof wagers)[number]) => ({ id: w.id, campaignId: w.campaignId, kind: w.kind, label: WAGER_KINDS[w.kind as WagerKind] ?? w.kind, short: shortOf(w.kind), stake: w.stake, status: w.status, proposerId: w.proposerId, proposer: displayName(w.proposer), accepterId: w.accepterId, accepter: displayName(w.accepter), winnerId: w.winnerId, note: w.note, period: w.period, createdAt: w.createdAt.toISOString(), settledAt: w.settledAt?.toISOString() ?? null, actions: wagerActions(w, userId) });
  // Who can be challenged on the selected campaign: its active agents.
  const players = selected ? (await prisma.campaignAgent.findMany({ where: { tenantId, campaignId: selected.id, user: { active: true } }, select: { user: { select: { id: true, firstName: true, email: true } } } })).map((a) => ({ id: a.user.id, name: displayName(a.user) })).sort((a, b) => a.name.localeCompare(b.name)) : [];

  const current = selected ? runByCampaign.get(selected.id) ?? null : null;
  const run = current && selected ? await summarise(current, selected.name, now) : null;
  const pastRows = selected ? await prisma.pokerRun.findMany({ where: { tenantId, campaignId: selected.id, status: "ENDED" }, orderBy: { endedAt: "desc" }, take: 5 }) : [];
  const pastRuns: RunSummary[] = [];
  for (const r of pastRows) pastRuns.push(await summarise(r, selected!.name, now));

  return {
    campaigns: campaigns.map((c) => {
      const r = runByCampaign.get(c.id);
      return { id: c.id, name: c.name, status: c.status, betsEnabled: c.betsEnabled, weeklyPoints: c.weeklyPoints, maxStake: c.maxStake, run: r ? { id: r.id, name: r.name, prize: r.prize, endsAt: r.endsAt.toISOString(), daysLeft: daysLeft(r.endsAt, now), live: runIsLive(r, now) } : null };
    }),
    campaign: selected ? { id: selected.id, name: selected.name, status: selected.status, betsEnabled: selected.betsEnabled, weeklyPoints: selected.weeklyPoints, maxStake: selected.maxStake } : null,
    dispositions,
    points: me?.points ?? 0,
    kinds: Object.entries(WAGER_KINDS).map(([k, label]) => ({ kind: k, label, short: shortOf(k), instant: INSTANT_KINDS.includes(k as WagerKind) })),
    players,
    wagers: wagers.map(shape),
    settled: settled.map(shape),
    run,
    pastRuns,
    ledger: ledger.map((l) => ({ id: l.id, delta: l.delta, reason: l.reason, kind: ledgerKind(l.reason), at: l.createdAt.toISOString() })),
  };
}
export type GamesOverview = Awaited<ReturnType<typeof gamesOverview>>;
