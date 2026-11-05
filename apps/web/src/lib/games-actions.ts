"use server";

import { requireSession } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { canManageGames, requireManageGames, requireRight } from "@/lib/rights";

export type RunSummary = {
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
  rows: { userId: string; name: string; cards: string[]; hand: { name: string; cards: string[] } | null }[];
  winner: { userId: string; name: string; hand: string; cards: string[] } | null;
  endedAt: string | null;
};
export type GamesCampaign = { id: string; name: string; status: string; betsEnabled: boolean; weeklyPoints: number; maxStake: number };
export type GamesOverview = {
  /** Campaigns the person plays on (managers: every active or paused campaign), each with its live run if any. */
  campaigns: (GamesCampaign & { run: { id: string; name: string; prize: string | null; endsAt: string; daysLeft: number; live: boolean } | null })[];
  /** The selected campaign; null when the person is on none. */
  campaign: GamesCampaign | null;
  dispositions: { code: string; label: string; isSale: boolean; isContact: boolean }[];
  points: number;
  kinds: { kind: string; label: string; instant: boolean }[];
  wagers: WagerRow[];
  settled: WagerRow[];
  run: RunSummary | null;
  pastRuns: RunSummary[];
  ledger: { delta: number; reason: string; at: string }[];
};
export type WagerRow = { id: string; campaignId: string | null; kind: string; label: string; stake: number; status: string; proposerId: string; proposer: string; accepterId: string | null; accepter: string; winnerId: string | null; note: string | null; period: string | null; createdAt: string };

type Result = { ok: true } | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.match(/\{"ok":false,"error":"(.*)"\}$/);
  return { ok: false, error: j ? j[1].replace(/\\"/g, '"') : m };
};

/** Managers see every campaign; agents the ones they are assigned to. */
export async function gamesOverview(campaignId?: string | null): Promise<GamesOverview> {
  const s = await requireSession();
  const scope = canManageGames(s) ? "all" : "mine";
  return engine<GamesOverview>(`/games?tenantId=${s.tenant.id}&userId=${s.user.id}&scope=${scope}${campaignId ? `&campaignId=${encodeURIComponent(campaignId)}` : ""}`);
}

export async function wager(input: { action: "propose" | "accept" | "withdraw"; campaignId?: string; wagerId?: string; accepterId?: string | null; kind?: string; stake?: number; note?: string }): Promise<Result> {
  const s = await requireSession();
  try {
    requireRight(s, "games");
    await engine("/games/wager", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, ...input }) });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Bets on or off for a campaign, with its Monday allowance and stake cap. ADMIN/SUPERVISOR, or a team leader with `manage_games`. */
export async function setCampaignBets(input: { campaignId: string; betsEnabled: boolean; weeklyPoints: number; maxStake: number }): Promise<Result> {
  const s = await requireSession();
  try {
    requireManageGames(s);
    await engine("/games/bets", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, ...input }) });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export type StartRunInput = { campaignId: string; name: string; startsAt: string; endsAt: string; prize: string; qualifies: string; codes: string };
export async function startPokerRun(input: StartRunInput): Promise<Result> {
  const s = await requireSession();
  try {
    requireManageGames(s);
    await engine("/games/run", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, action: "start", ...input }) });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function endPokerRun(runId: string): Promise<Result> {
  const s = await requireSession();
  try {
    requireManageGames(s);
    await engine("/games/run", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, action: "end", runId }) });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export type Suggestion = { title: string; say: string; why: string };
export async function assistSuggest(campaignId: string, leadId: string | null, objection: string, goal: "sale" | "service" = "sale"): Promise<{ ok: true; suggestions: Suggestion[]; tone: string } | { ok: false; error: string }> {
  const s = await requireSession();
  return engine("/assist/suggest", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, campaignId, leadId, objection, goal }) });
}

export async function campaignRebuttals(campaignId: string): Promise<{ objection: string; response: string }[]> {
  const s = await requireSession();
  const { prisma } = await import("@strowger/db");
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { rebuttals: true } });
  return (c?.rebuttals as { objection: string; response: string }[] | null) ?? [];
}
