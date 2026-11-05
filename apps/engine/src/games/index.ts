// Games: points bets between agents and the poker run. Hooks are called from
// the dialer (a dial, a disposition); settlement of period bets and the
// weekly top-up run from the scheduler. Rules in @strowger/shared/games.
import { prisma } from "@strowger/db";
import { INSTANT_KINDS, WAGER_KINDS, bestHand, compareHands, dayKey, dealCard, periodKeyFor, weekKey, type WagerKind } from "@strowger/shared/games";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";

export interface GamesSettings {
  enabled: boolean;
  weeklyPoints: number;
  /** "day" | "week": how often the poker run resets and pays. */
  pokerPeriod: "day" | "week";
  pokerPrize: string;
  maxStake: number;
}
export const DEFAULT_GAMES: GamesSettings = { enabled: true, weeklyPoints: 10_000, pokerPeriod: "week", pokerPrize: "", maxStake: 5_000 };

export async function gamesSettings(tenantId: string): Promise<GamesSettings> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const g = ((t?.settings ?? {}) as { games?: Partial<GamesSettings> }).games ?? {};
  return { ...DEFAULT_GAMES, ...g };
}

const pokerPeriod = (g: GamesSettings, d = new Date()) => (g.pokerPeriod === "day" ? dayKey(d) : weekKey(d));

async function credit(tenantId: string, userId: string, delta: number, reason: string, wagerId?: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { points: { increment: delta } } }),
    prisma.pointsLedger.create({ data: { tenantId, userId, delta, reason, wagerId } }),
  ]);
  emitToAgent(userId, "games:points", { delta, reason });
}

// ---- Bets

export async function proposeWager(tenantId: string, proposerId: string, accepterId: string | null, kind: WagerKind, stake: number, note?: string) {
  const g = await gamesSettings(tenantId);
  if (!g.enabled) throw new Error("Games are switched off");
  if (!(kind in WAGER_KINDS)) throw new Error("Unknown bet");
  if (!Number.isInteger(stake) || stake <= 0 || stake > g.maxStake) throw new Error(`Stake must be 1 to ${g.maxStake} points`);
  const me = await prisma.user.findFirst({ where: { id: proposerId, tenantId } });
  if (!me || me.points < stake) throw new Error("Not enough points");
  if (accepterId === proposerId) throw new Error("Bet someone else");
  const w = await prisma.wager.create({ data: { tenantId, proposerId, accepterId, kind, stake, note: note?.slice(0, 140) ?? null, period: periodKeyFor(kind) } });
  await credit(tenantId, proposerId, -stake, `Bet placed: ${WAGER_KINDS[kind]}`, w.id);
  emitToTenant(tenantId, "games:wager", { id: w.id, status: "OPEN" });
  return w;
}

export async function acceptWager(tenantId: string, userId: string, wagerId: string) {
  const w = await prisma.wager.findFirst({ where: { id: wagerId, tenantId, status: "OPEN" } });
  if (!w) throw new Error("That bet is gone");
  if (w.proposerId === userId) throw new Error("That is your own bet");
  if (w.accepterId && w.accepterId !== userId) throw new Error("That bet was offered to somebody else");
  const me = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!me || me.points < w.stake) throw new Error("Not enough points");
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "OPEN" }, data: { status: "ACCEPTED", accepterId: userId } });
  if (upd.count !== 1) throw new Error("Somebody beat you to it");
  await credit(tenantId, userId, -w.stake, `Bet accepted: ${WAGER_KINDS[w.kind as WagerKind]}`, w.id);
  emitToTenant(tenantId, "games:wager", { id: w.id, status: "ACCEPTED" });
  return prisma.wager.findUniqueOrThrow({ where: { id: w.id } });
}

export async function withdrawWager(tenantId: string, userId: string, wagerId: string) {
  const w = await prisma.wager.findFirst({ where: { id: wagerId, tenantId, status: "OPEN", proposerId: userId } });
  if (!w) throw new Error("Only an open bet of yours can be withdrawn");
  await prisma.wager.update({ where: { id: w.id }, data: { status: "DECLINED", settledAt: new Date() } });
  await credit(tenantId, w.proposerId, w.stake, "Bet withdrawn", w.id);
  emitToTenant(tenantId, "games:wager", { id: w.id, status: "DECLINED" });
}

async function settle(wagerId: string, winnerId: string | null): Promise<void> {
  const w = await prisma.wager.findUnique({ where: { id: wagerId } });
  if (!w || w.status !== "ACCEPTED" || !w.accepterId) return;
  const upd = await prisma.wager.updateMany({ where: { id: w.id, status: "ACCEPTED" }, data: { status: "SETTLED", winnerId, settledAt: new Date() } });
  if (upd.count !== 1) return;
  const label = WAGER_KINDS[w.kind as WagerKind];
  if (winnerId) await credit(w.tenantId, winnerId, w.stake * 2, `Won: ${label}`, w.id);
  else {
    await credit(w.tenantId, w.proposerId, w.stake, `Push: ${label}`, w.id);
    await credit(w.tenantId, w.accepterId, w.stake, `Push: ${label}`, w.id);
  }
  emitToTenant(w.tenantId, "games:wager", { id: w.id, status: "SETTLED", winnerId });
}

/** An instant event for one agent: settle every accepted "next …" bet of that kind they are party to. */
async function settleInstant(tenantId: string, kind: WagerKind, userId: string): Promise<void> {
  const open = await prisma.wager.findMany({ where: { tenantId, kind, status: "ACCEPTED", OR: [{ proposerId: userId }, { accepterId: userId }] } });
  for (const w of open) await settle(w.id, userId);
}

type Stat = "calls" | "contacts" | "sales";
async function statFor(tenantId: string, userId: string, stat: Stat, since: Date): Promise<number> {
  if (stat === "calls") return prisma.call.count({ where: { tenantId, agentId: userId, direction: "OUTBOUND", dialedAt: { gte: since } } });
  return prisma.call.count({ where: { tenantId, agentId: userId, dialedAt: { gte: since }, disposition: stat === "sales" ? { isSale: true } : { isContact: true } } });
}

/** Period bets whose period has ended: compare the two stats, pay the winner, push on a tie. */
export async function settlePeriodWagers(now = new Date()): Promise<void> {
  const today = dayKey(now);
  const thisWeek = weekKey(now);
  const due = await prisma.wager.findMany({ where: { status: "ACCEPTED", period: { not: null }, NOT: [{ period: today }, { period: thisWeek }] } });
  for (const w of due) {
    const kind = w.kind as WagerKind;
    const stat: Stat = kind.startsWith("MOST_CALLS") ? "calls" : kind.startsWith("MOST_CONTACTS") ? "contacts" : "sales";
    const since = kind.endsWith("_WEEK") ? startOfIsoWeek(w.period!) : new Date(`${w.period}T00:00:00Z`);
    const until = kind.endsWith("_WEEK") ? new Date(since.getTime() + 7 * 86_400_000) : new Date(since.getTime() + 86_400_000);
    const [a, b] = await Promise.all([statIn(w.tenantId, w.proposerId, stat, since, until), statIn(w.tenantId, w.accepterId!, stat, since, until)]);
    await settle(w.id, a === b ? null : a > b ? w.proposerId : w.accepterId);
  }
  // Open (unaccepted) period bets past their period: refund.
  const stale = await prisma.wager.findMany({ where: { status: "OPEN", period: { not: null }, NOT: [{ period: today }, { period: thisWeek }] } });
  for (const w of stale) {
    await prisma.wager.update({ where: { id: w.id }, data: { status: "VOID", settledAt: now } });
    await credit(w.tenantId, w.proposerId, w.stake, "Bet expired, nobody took it", w.id);
  }
}
async function statIn(tenantId: string, userId: string, stat: Stat, since: Date, until: Date): Promise<number> {
  const base = { tenantId, agentId: userId, dialedAt: { gte: since, lt: until } };
  if (stat === "calls") return prisma.call.count({ where: { ...base, direction: "OUTBOUND" } });
  return prisma.call.count({ where: { ...base, disposition: stat === "sales" ? { isSale: true } : { isContact: true } } });
}
function startOfIsoWeek(key: string): Date {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() - (day - 1) * 86_400_000);
  return new Date(monday.getTime() + (w - 1) * 7 * 86_400_000);
}

/** Every Monday (UTC) each agent's points are set to the weekly allowance. */
export async function weeklyTopUp(now = new Date()): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, settings: true } });
  for (const t of tenants) {
    const g = { ...DEFAULT_GAMES, ...(((t.settings ?? {}) as { games?: Partial<GamesSettings> }).games ?? {}) };
    if (!g.enabled) continue;
    const users = await prisma.user.findMany({ where: { tenantId: t.id, active: true, roles: { hasSome: ["AGENT", "TEAM_LEADER"] } }, select: { id: true, points: true } });
    for (const u of users) {
      const delta = g.weeklyPoints - u.points;
      if (delta !== 0) await credit(t.id, u.id, delta, `Monday top-up to ${g.weeklyPoints.toLocaleString()} (${weekKey(now)})`);
    }
  }
}

// ---- Poker run

export async function dealForSale(tenantId: string, userId: string, callId: string): Promise<string | null> {
  const g = await gamesSettings(tenantId);
  if (!g.enabled) return null;
  const period = pokerPeriod(g);
  const held = (await prisma.pokerCard.findMany({ where: { tenantId, userId, period }, select: { card: true } })).map((c) => c.card);
  const card = dealCard(held);
  if (!card) return null;
  await prisma.pokerCard.create({ data: { tenantId, userId, period, card, callId } });
  emitToAgent(userId, "games:card", { card, period });
  emitToTenant(tenantId, "games:poker", { userId, period });
  return card;
}

export async function pokerStandings(tenantId: string, period?: string) {
  const g = await gamesSettings(tenantId);
  const p = period ?? pokerPeriod(g);
  const cards = await prisma.pokerCard.findMany({ where: { tenantId, period: p }, include: { user: { select: { firstName: true, email: true } } }, orderBy: { dealtAt: "asc" } });
  const byUser = new Map<string, { userId: string; name: string; cards: string[] }>();
  for (const c of cards) {
    const e = byUser.get(c.userId) ?? { userId: c.userId, name: c.user.firstName ?? c.user.email.split("@")[0]!, cards: [] };
    e.cards.push(c.card);
    byUser.set(c.userId, e);
  }
  const rows = [...byUser.values()].map((e) => ({ ...e, hand: bestHand(e.cards) }));
  rows.sort((a, b) => (a.hand && b.hand ? compareHands(b.hand, a.hand) : a.hand ? -1 : 1) || b.cards.length - a.cards.length);
  return { period: p, pokerPeriod: g.pokerPeriod, prize: g.pokerPrize, rows: rows.map((r) => ({ userId: r.userId, name: r.name, cards: r.cards, hand: r.hand ? { name: r.hand.name, cards: r.hand.cards } : null })) };
}

// ---- Hooks from the dialer

export async function onDialed(tenantId: string, agentId: string): Promise<void> {
  try {
    await settleInstant(tenantId, "NEXT_CALL", agentId);
  } catch (e) {
    log.warn({ err: e }, "games: dial hook failed");
  }
}

export async function onDispositioned(tenantId: string, agentId: string, callId: string, flags: { isSale: boolean; isContact: boolean }): Promise<void> {
  try {
    if (flags.isContact) await settleInstant(tenantId, "NEXT_CONTACT", agentId);
    if (flags.isSale) {
      await settleInstant(tenantId, "NEXT_SALE", agentId);
      await dealForSale(tenantId, agentId, callId);
    }
  } catch (e) {
    log.warn({ err: e }, "games: disposition hook failed");
  }
}

export async function gamesOverview(tenantId: string, userId: string) {
  const [g, me, wagers, standings, ledger] = await Promise.all([
    gamesSettings(tenantId),
    prisma.user.findFirst({ where: { id: userId, tenantId }, select: { points: true } }),
    prisma.wager.findMany({ where: { tenantId, status: { in: ["OPEN", "ACCEPTED"] } }, orderBy: { createdAt: "desc" }, take: 50, include: { proposer: { select: { firstName: true, email: true } }, accepter: { select: { firstName: true, email: true } } } }),
    pokerStandings(tenantId),
    prisma.pointsLedger.findMany({ where: { tenantId, userId }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const settled = await prisma.wager.findMany({ where: { tenantId, status: "SETTLED", OR: [{ proposerId: userId }, { accepterId: userId }] }, orderBy: { settledAt: "desc" }, take: 10, include: { proposer: { select: { firstName: true, email: true } }, accepter: { select: { firstName: true, email: true } } } });
  const name = (u: { firstName: string | null; email: string } | null) => (u ? (u.firstName ?? u.email.split("@")[0]!) : "anyone");
  const shape = (w: (typeof wagers)[number]) => ({ id: w.id, kind: w.kind, label: WAGER_KINDS[w.kind as WagerKind] ?? w.kind, stake: w.stake, status: w.status, proposerId: w.proposerId, proposer: name(w.proposer), accepterId: w.accepterId, accepter: name(w.accepter), winnerId: w.winnerId, note: w.note, period: w.period, createdAt: w.createdAt.toISOString() });
  return {
    settings: g,
    points: me?.points ?? 0,
    kinds: Object.entries(WAGER_KINDS).map(([k, label]) => ({ kind: k, label, instant: INSTANT_KINDS.includes(k as WagerKind) })),
    wagers: wagers.map(shape),
    settled: settled.map(shape),
    poker: standings,
    ledger: ledger.map((l) => ({ delta: l.delta, reason: l.reason, at: l.createdAt.toISOString() })),
  };
}
