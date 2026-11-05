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

/** A card not already in `held`, uniformly at random; null when the deck is spent. */
export function dealCard(held: string[], random = Math.random): string | null {
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
