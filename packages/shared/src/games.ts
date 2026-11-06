// Games (owner, 5 Nov): a weekly points allowance agents bet against each
// other on dialing stats, and a poker run where every sale deals a card and
// the best five-card hand of the period wins. Pure rules here, tested.

export const WAGER_KINDS = {
  NEXT_SALE: "Who gets the next sale",
  NEXT_CONTACT: "Who gets the next live contact",
  NEXT_CALL: "Who places the next call",
  MOST_CALLS_TODAY: "Most calls today",
  MOST_CONTACTS_TODAY: "Most contacts today",
  MOST_SALES_TODAY: "Most sales today",
  MOST_SALES_WEEK: "Most sales this week",
} as const;
export type WagerKind = keyof typeof WAGER_KINDS;
/** Short names for toasts and the bet board ("Maria won 500 pts from you on Next sale"). */
export const WAGER_SHORT: Record<WagerKind, string> = {
  NEXT_SALE: "Next sale",
  NEXT_CONTACT: "Next contact",
  NEXT_CALL: "Next call",
  MOST_CALLS_TODAY: "Most calls today",
  MOST_CONTACTS_TODAY: "Most contacts today",
  MOST_SALES_TODAY: "Most sales today",
  MOST_SALES_WEEK: "Most sales this week",
};
/** The longest trash-talk note on a bet. */
export const WAGER_NOTE_MAX = 80;
export const INSTANT_KINDS: WagerKind[] = ["NEXT_SALE", "NEXT_CONTACT", "NEXT_CALL"];

/** YYYY-MM-DD in UTC. */
export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
/** ISO week key YYYY-Www in UTC. */
export function weekKey(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
export function periodKeyFor(kind: WagerKind, d = new Date()): string | null {
  if (kind.endsWith("_TODAY")) return dayKey(d);
  if (kind.endsWith("_WEEK")) return weekKey(d);
  return null;
}

// ---- Poker

export const RANKS = "23456789TJQKA";
export const SUITS = "CDHS";
export const DECK: string[] = [...SUITS].flatMap((s) => [...RANKS].map((r) => r + s));

/** Seven-card stud (owner, 6 Nov): a player holds at most seven cards in a run; the best five count. */
export const HAND_MAX = 7;

/** A card not already in `held`, uniformly at random; null when the hand is full (`max`, seven by default) or the deck is spent. */
export function dealCard(held: string[], random = Math.random, max = HAND_MAX): string | null {
  if (held.length >= max) return null;
  const left = DECK.filter((c) => !held.includes(c));
  if (left.length === 0) return null;
  return left[Math.floor(random() * left.length)] ?? null;
}

export const HAND_NAMES = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"] as const;

export interface HandRank {
  /** 0 = high card … 8 = straight flush. */
  category: number;
  name: (typeof HAND_NAMES)[number];
  /** Tiebreak values, high to low; compare lexicographically. */
  kickers: number[];
  /** The five (or fewer) cards that make the hand. */
  cards: string[];
}

const rankValue = (c: string) => RANKS.indexOf(c[0]!) + 2;

function rankFive(cards: string[]): HandRank {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map((c) => c[1]);
  const flush = cards.length === 5 && suits.every((s) => s === suits[0]);
  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (cards.length === 5 && uniq.length === 5) {
    if (vals[0]! - vals[4]! === 4) straightHigh = vals[0]!;
    else if (vals.join(",") === "14,5,4,3,2") straightHigh = 5; // wheel
  }
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const kick = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]);
  const mk = (category: number, kickers: number[]): HandRank => ({ category, name: HAND_NAMES[category]!, kickers, cards });
  if (straightHigh && flush) return mk(8, [straightHigh]);
  if (shape[0] === 4) return mk(7, kick);
  if (shape[0] === 3 && shape[1] === 2) return mk(6, kick);
  if (flush) return mk(5, vals);
  if (straightHigh) return mk(4, [straightHigh]);
  if (shape[0] === 3) return mk(3, kick);
  if (shape[0] === 2 && shape[1] === 2) return mk(2, kick);
  if (shape[0] === 2) return mk(1, kick);
  return mk(0, vals);
}

function combos<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [h, ...t] = arr;
  return [...combos(t, k - 1).map((c) => [h as T, ...c]), ...combos(t, k)];
}

export function compareHands(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const d = (a.kickers[i] ?? 0) - (b.kickers[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Best hand from any number of cards (fewer than five is ranked as what it is: a pair of two cards beats a high card). */
export function bestHand(cards: string[]): HandRank | null {
  if (cards.length === 0) return null;
  const n = Math.min(5, cards.length);
  let best: HandRank | null = null;
  for (const c of combos(cards, n)) {
    const r = rankFive(c);
    if (!best || compareHands(r, best) > 0) best = r;
  }
  return best;
}

// ---- Poker runs (owner, 5 Nov: "Admin should be able to set up a poker run")
//
// A run belongs to one campaign, has a name, a window, a prize and a rule for
// what deals a card. Only one ACTIVE run per campaign at a time.

export const POKER_QUALIFIERS = {
  SALE: "Every sale",
  CONTACT: "Every live contact",
  CODES: "These disposition codes",
} as const;
export type PokerQualifier = keyof typeof POKER_QUALIFIERS;

export interface PokerRule {
  qualifies: PokerQualifier;
  /** Disposition codes, upper-case, for CODES. */
  codes: string[];
}

/** Whether a disposition earns a card under the run's rule. Codes compare case-insensitively. */
export function earnsCard(rule: PokerRule, outcome: { isSale: boolean; isContact: boolean; code: string }): boolean {
  if (rule.qualifies === "SALE") return outcome.isSale;
  if (rule.qualifies === "CONTACT") return outcome.isContact;
  const code = outcome.code.trim().toUpperCase();
  return rule.codes.some((c) => c.trim().toUpperCase() === code);
}

/** Parse the rule as the forms post it: a qualifier and a free-text code list ("SALE, XFER"). Unknown qualifier falls back to SALE. */
export function parsePokerRule(qualifies: string | null | undefined, codes: string | string[] | null | undefined): PokerRule {
  const q = (qualifies ?? "").toUpperCase();
  const list = (Array.isArray(codes) ? codes : (codes ?? "").split(/[\s,;]+/)).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (q === "CODES") return list.length ? { qualifies: "CODES", codes: [...new Set(list)] } : { qualifies: "SALE", codes: [] };
  return { qualifies: q === "CONTACT" ? "CONTACT" : "SALE", codes: [] };
}

/** "Deal a card every N qualifying outcomes": whole numbers 1..100, anything else is 1. */
export function clampOutcomesPerCard(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(100, v) : 1;
}

/** The run form's starting N: sales are rare, so a card each; live contacts come often, so one every five. */
export function defaultOutcomesPerCard(q: string): number {
  return q === "CONTACT" ? 5 : 1;
}

/** "sale" / "5 live contacts" / "3 of those dispositions": the run form's label and the panel's rule line. */
export function outcomeNoun(q: string, n: number, codes: string[] = []): string {
  const one = n === 1;
  if (q === "CONTACT") return one ? "live contact" : `${n} live contacts`;
  if (q === "CODES") {
    const what = codes.length ? codes.join(" / ") : "qualifying disposition";
    return one ? what : `${n} × ${what}`;
  }
  return one ? "sale" : `${n} sales`;
}

/** How many cards an agent's qualifying outcomes have earned: one at every multiple of `perCard`, never past seven. */
export function cardsEarned(outcomes: number, perCard: number): number {
  const n = clampOutcomesPerCard(perCard);
  return Math.min(HAND_MAX, Math.floor(Math.max(0, outcomes) / n));
}

export interface CardProgress {
  /** Qualifying outcomes since the last card (0 when N is 1: the slot simply waits). */
  since: number;
  perCard: number;
  /** since ÷ perCard, 0..1, for the ring on the next slot. */
  fraction: number;
  /** Seven cards held: nothing more comes. */
  full: boolean;
}
/** Progress toward the next card, for the ring round the next locked slot. */
export function cardProgress(outcomes: number, perCard: number, held: number): CardProgress {
  const n = clampOutcomesPerCard(perCard);
  if (held >= HAND_MAX) return { since: 0, perCard: n, fraction: 0, full: true };
  const since = Math.max(0, outcomes) % n;
  return { since, perCard: n, fraction: since / n, full: false };
}

/** The console's line when no more cards can come. */
export function handFullLine(held: number): string | null {
  return held >= HAND_MAX ? `Your hand is full: ${HAND_MAX}/${HAND_MAX}` : null;
}

/** Monday 00:00 UTC of the week holding `d`, and the following Monday: the "this week" run window. */
export function thisWeekWindow(d = new Date()): { startsAt: Date; endsAt: Date } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  const startsAt = new Date(t.getTime() - (day - 1) * 86_400_000);
  return { startsAt, endsAt: new Date(startsAt.getTime() + 7 * 86_400_000) };
}

/** Whole days left in a run (ceil), never below zero. */
export function daysLeft(endsAt: Date | string, now = new Date()): number {
  const end = typeof endsAt === "string" ? new Date(endsAt) : endsAt;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}

/** Whether a run is live now: ACTIVE and inside its window. */
export function runIsLive(run: { status: string; startsAt: Date | string; endsAt: Date | string }, now = new Date()): boolean {
  if (run.status !== "ACTIVE") return false;
  const s = new Date(run.startsAt).getTime();
  const e = new Date(run.endsAt).getTime();
  return now.getTime() >= s && now.getTime() < e;
}

export function prettyCard(c: string): string {
  const suit = { C: "♣", D: "♦", H: "♥", S: "♠" }[c[1]!] ?? c[1];
  const rank = c[0] === "T" ? "10" : c[0];
  return `${rank}${suit}`;
}

// ---- What the agent sees (owner, 5 Nov: "The agent should actually see their cards")

const RANK_WORDS: Record<string, [string, string]> = {
  "2": ["two", "twos"], "3": ["three", "threes"], "4": ["four", "fours"], "5": ["five", "fives"], "6": ["six", "sixes"],
  "7": ["seven", "sevens"], "8": ["eight", "eights"], "9": ["nine", "nines"], T: ["ten", "tens"], J: ["jack", "jacks"],
  Q: ["queen", "queens"], K: ["king", "kings"], A: ["ace", "aces"],
};
const SUIT_WORDS: Record<string, string> = { C: "clubs", D: "diamonds", H: "hearts", S: "spades" };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const wordOf = (value: number, plural = false) => RANK_WORDS[RANKS[value - 2]!]![plural ? 1 : 0];

/** "Seven of hearts": the accessible name of a card. */
export function cardLabel(c: string): string {
  const r = RANK_WORDS[c[0]!];
  const s = SUIT_WORDS[c[1]!];
  return r && s ? `${cap(r[0])} of ${s}` : c;
}
/** Hearts and diamonds print red. */
export function isRed(c: string): boolean {
  return c[1] === "H" || c[1] === "D";
}
/** The rank as printed in a card's corner ("10", "K"). */
export function rankGlyph(c: string): string {
  return c[0] === "T" ? "10" : (c[0] ?? "");
}

/** The hand in words: "Two pair, kings and sevens", "Full house, aces over kings", "Ace high". */
export function describeHand(h: HandRank): string {
  const [a = 0, b = 0] = h.kickers;
  switch (h.category) {
    case 8:
      return a === 14 ? "Royal flush" : `Straight flush, ${wordOf(a)} high`;
    case 7:
      return `Four ${wordOf(a, true)}`;
    case 6:
      return `Full house, ${wordOf(a, true)} over ${wordOf(b, true)}`;
    case 5:
      return `Flush, ${wordOf(a)} high`;
    case 4:
      return `Straight, ${wordOf(a)} high`;
    case 3:
      return `Three ${wordOf(a, true)}`;
    case 2:
      return `Two pair, ${wordOf(a, true)} and ${wordOf(b, true)}`;
    case 1:
      return `Pair of ${wordOf(a, true)}`;
    default:
      return `${cap(wordOf(a))} high`;
  }
}

/** The hand's short name for a pill: "Royal flush", "Full house", "Pair". */
export function handShort(h: HandRank): string {
  return h.category === 8 && h.kickers[0] === 14 ? "Royal flush" : h.name;
}

/** The cards that make the hand (lifted on screen): the pairs/trips/quads, all five of a straight,
 *  flush or full house, or the top card of a high-card hand. */
export function handMakers(h: HandRank): string[] {
  if (h.category === 4 || h.category === 5 || h.category === 6 || h.category === 8) return [...h.cards];
  if (h.category === 0) {
    const top = [...h.cards].sort((x, y) => rankValue(y) - rankValue(x))[0];
    return top ? [top] : [];
  }
  const counts = new Map<string, number>();
  for (const c of h.cards) counts.set(c[0]!, (counts.get(c[0]!) ?? 0) + 1);
  return h.cards.filter((c) => (counts.get(c[0]!) ?? 0) >= 2);
}

/** Rank everyone on a run (owner, 6 Nov): best hand (compareHands), then cards held, then contacts.
 *  `place` is shared only on a tie in all three. */
export function rankStandings<T extends { cards: string[]; contacts?: number }>(rows: T[]): (T & { hand: HandRank | null; place: number })[] {
  const withHands = rows.map((r) => ({ ...r, hand: bestHand(r.cards) }));
  type R = { hand: HandRank | null; cards: string[]; contacts?: number };
  const byHand = (x: R, y: R) => (x.hand && y.hand ? compareHands(y.hand, x.hand) : x.hand ? -1 : y.hand ? 1 : 0);
  const cmp = (x: R, y: R) => byHand(x, y) || y.cards.length - x.cards.length || (y.contacts ?? 0) - (x.contacts ?? 0);
  withHands.sort(cmp);
  const out: (T & { hand: HandRank | null; place: number })[] = [];
  withHands.forEach((r, i) => {
    const prev = out[i - 1];
    out.push({ ...r, place: prev && cmp(prev, r) === 0 ? prev.place : i + 1 });
  });
  return out;
}

export function ordinal(n: number): string {
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
/** "You're 2nd of 6", "You're tied 1st of 6", "No cards yet". */
export function placeLine(rows: { userId: string; place: number }[], userId: string): string {
  const me = rows.find((r) => r.userId === userId);
  if (!me) return rows.length ? `No cards yet · ${rows.length} on the board` : "No cards yet";
  const tied = rows.filter((r) => r.place === me.place).length > 1;
  return `You're ${tied ? "tied " : ""}${ordinal(me.place)} of ${rows.length}`;
}

/** "2 days 5 hours left", "3 hours left", "40 min left", "ended". */
export function timeLeft(endsAt: Date | string, now = new Date()): string {
  const ms = new Date(endsAt).getTime() - now.getTime();
  if (ms <= 0) return "ended";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${plural(days, "day")}${hours ? ` ${plural(hours, "hour")}` : ""} left`;
  if (hours > 0) return `${plural(hours, "hour")} left`;
  return `${Math.max(1, mins)} min left`;
}

// ---- Points ledger, as the purse's history shows it

export type LedgerKind = "topup" | "stake" | "won" | "lost" | "refund" | "other";
/** What a points movement was, from the ledger reason the engine writes (games/index.ts `credit`). */
export function ledgerKind(reason: string): LedgerKind {
  if (/top(ped)?[- ]up/i.test(reason)) return "topup";
  if (/^Won:/.test(reason)) return "won";
  if (/^Lost:/.test(reason)) return "lost";
  if (/^Bet (placed|accepted):/.test(reason)) return "stake";
  if (/^(Push:|Bet withdrawn|Bet expired|Declined)/.test(reason)) return "refund";
  return "other";
}

// ---- Bets between agents: who may do what to an open bet

export interface WagerSides {
  status: string;
  proposerId: string;
  accepterId: string | null;
}
export type WagerAction = "accept" | "decline" | "withdraw";
/** An OPEN bet: the proposer may withdraw it; a bet offered to me I may accept or decline; an open
 *  "anyone" bet anyone else may accept (there is nothing to decline). Anything not OPEN: nothing. */
export function wagerActions(w: WagerSides, userId: string): WagerAction[] {
  if (w.status !== "OPEN") return [];
  if (w.proposerId === userId) return ["withdraw"];
  if (w.accepterId === userId) return ["accept", "decline"];
  if (!w.accepterId) return ["accept"];
  return [];
}
/** Declining a challenge: the bet becomes DECLINED and the proposer's stake goes back in full. */
export function declinePlan(w: WagerSides & { stake: number }, userId: string): { status: "DECLINED"; refundTo: string; amount: number } {
  if (!wagerActions(w, userId).includes("decline")) throw new Error("Only a bet offered to you can be declined");
  return { status: "DECLINED", refundTo: w.proposerId, amount: w.stake };
}

export interface SettledEvent {
  winnerId: string | null;
  proposerId: string;
  accepterId: string | null;
  proposer: string;
  accepter: string;
  short: string;
  stake: number;
}
/** The toast each side sees when a bet settles; null for anyone not party to it. */
export function settlementLine(e: SettledEvent, userId: string): { text: string; tone: "won" | "lost" | "push" } | null {
  if (userId !== e.proposerId && userId !== e.accepterId) return null;
  const pts = `${e.stake.toLocaleString("en-US")} pts`;
  const other = userId === e.proposerId ? e.accepter : e.proposer;
  if (!e.winnerId) return { text: `Push on ${e.short}: your ${pts} are back`, tone: "push" };
  if (e.winnerId === userId) return { text: `You won ${pts} from ${other} on ${e.short}`, tone: "won" };
  return { text: `${other} won ${pts} from you on ${e.short}`, tone: "lost" };
}

// ---- Agent levels

export const AGENT_RIGHTS = {
  manual_dial: "Dial a number by hand",
  send_text: "Send texts to leads",
  transfer: "Transfer calls",
  assist_screen: "Use the assist screen (second monitor)",
  chat_everyone: "Post in Everyone chat",
  games: "Play the games (bets, poker run)",
  manage_games: "Start poker runs and switch bets on for a campaign (team leaders)",
  see_leaderboard: "See the team leaderboard",
  voicemail_drop: "Leave a voicemail and move on",
  skip_lead: "Skip a lead in preview",
  /** Owner, 5 Nov: off at every level until the typed-number transfer UI exists. The campaign's destinations need no right. */
  transfer_any_number: "Transfer to any typed number",
} as const;
export type AgentRight = keyof typeof AGENT_RIGHTS;
export const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Defaults: level 1 gets the basics, rights widen with level. Tenant settings `levelRights` override per level. */
/** Owner, 5 Nov: every agent may dial by hand; the rest widens with level. */
export const DEFAULT_LEVEL_RIGHTS: Record<number, AgentRight[]> = {
  1: ["see_leaderboard", "voicemail_drop", "manual_dial"],
  2: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone"],
  3: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead"],
  4: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead", "assist_screen"],
  5: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead", "assist_screen", "transfer"],
  6: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead", "assist_screen", "transfer"],
  7: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead", "assist_screen", "transfer"],
  8: ["see_leaderboard", "voicemail_drop", "manual_dial", "games", "chat_everyone", "send_text", "skip_lead", "assist_screen", "transfer"],
};

/** Rights nobody gets by level alone; a tenant grants them in Settings → Agent levels. */
export const OPT_IN_RIGHTS: AgentRight[] = ["manage_games"];

export function rightsForLevel(level: number, overrides?: Record<string, string[]> | null): Set<AgentRight> {
  const l = Math.max(1, Math.min(8, Math.round(level || 1)));
  const list = overrides?.[String(l)] ?? DEFAULT_LEVEL_RIGHTS[l] ?? [];
  return new Set(list.filter((r): r is AgentRight => r in AGENT_RIGHTS));
}

// ---- Campaign bets switch

/** The Monday allowance and stake cap as stored: whole numbers, allowance 0..1,000,000, stake 1..1,000,000. */
export function clampBetSettings(input: { weeklyPoints: number; maxStake: number }): { weeklyPoints: number; maxStake: number } {
  return {
    weeklyPoints: Math.max(0, Math.min(1_000_000, Math.round(input.weeklyPoints) || 0)),
    maxStake: Math.max(1, Math.min(1_000_000, Math.round(input.maxStake) || 1)),
  };
}

/** Switching bets on tops every active agent on the campaign up to the allowance; nobody is lowered. */
export function betTopUps(agents: { id: string; points: number; active: boolean }[], weeklyPoints: number): { userId: string; delta: number }[] {
  return agents.filter((u) => u.active && u.points < weeklyPoints).map((u) => ({ userId: u.id, delta: weeklyPoints - u.points }));
}
