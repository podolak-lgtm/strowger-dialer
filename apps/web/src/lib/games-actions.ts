"use server";

import { requireSession } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { requireRight } from "@/lib/rights";

export type GamesOverview = {
  settings: { enabled: boolean; weeklyPoints: number; pokerPeriod: "day" | "week"; pokerPrize: string; maxStake: number };
  points: number;
  kinds: { kind: string; label: string; instant: boolean }[];
  wagers: WagerRow[];
  settled: WagerRow[];
  poker: { period: string; pokerPeriod: "day" | "week"; prize: string; rows: { userId: string; name: string; cards: string[]; hand: { name: string; cards: string[] } | null }[] };
  ledger: { delta: number; reason: string; at: string }[];
};
export type WagerRow = { id: string; kind: string; label: string; stake: number; status: string; proposerId: string; proposer: string; accepterId: string | null; accepter: string; winnerId: string | null; note: string | null; period: string | null; createdAt: string };

export async function gamesOverview(): Promise<GamesOverview> {
  const s = await requireSession();
  return engine<GamesOverview>(`/games?tenantId=${s.tenant.id}&userId=${s.user.id}`);
}

export async function wager(input: { action: "propose" | "accept" | "withdraw"; wagerId?: string; accepterId?: string | null; kind?: string; stake?: number; note?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await requireSession();
  try {
    requireRight(s, "games");
    await engine("/games/wager", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, ...input }) });
    return { ok: true };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const j = m.match(/\{"ok":false,"error":"(.*)"\}$/);
    return { ok: false, error: j ? j[1].replace(/\\"/g, '"') : m };
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
