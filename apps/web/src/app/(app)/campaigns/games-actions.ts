"use server";

// Campaign page → Games card: form actions over the games server actions
// (which check ADMIN/SUPERVISOR or a team leader with `manage_games`).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { endPokerRun, setCampaignBets, startPokerRun } from "@/lib/games-actions";

function back(campaignId: string, error?: string): never {
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/games");
  redirect(`/campaigns/${campaignId}${error ? `?games=${encodeURIComponent(error)}` : ""}#games`);
}

export async function saveCampaignBets(formData: FormData) {
  const campaignId = String(formData.get("campaignId"));
  const r = await setCampaignBets({
    campaignId,
    betsEnabled: formData.get("betsEnabled") === "on",
    weeklyPoints: Number(formData.get("weeklyPoints")),
    maxStake: Number(formData.get("maxStake")),
  });
  back(campaignId, r.ok ? undefined : r.error);
}

export async function startRunForm(formData: FormData) {
  const campaignId = String(formData.get("campaignId"));
  const period = String(formData.get("period") ?? "week");
  let startsAt = String(formData.get("startsAt") ?? "");
  let endsAt = String(formData.get("endsAt") ?? "");
  if (period === "week") {
    const { thisWeekWindow } = await import("@strowger/shared/games");
    const w = thisWeekWindow();
    startsAt = w.startsAt.toISOString();
    endsAt = w.endsAt.toISOString();
  }
  const r = await startPokerRun({
    campaignId,
    name: String(formData.get("name") ?? ""),
    startsAt,
    endsAt,
    prize: String(formData.get("prize") ?? ""),
    qualifies: String(formData.get("qualifies") ?? "SALE"),
    codes: String(formData.get("codes") ?? ""),
  });
  back(campaignId, r.ok ? undefined : r.error);
}

export async function endRunForm(formData: FormData) {
  const campaignId = String(formData.get("campaignId"));
  const r = await endPokerRun(String(formData.get("runId")));
  back(campaignId, r.ok ? undefined : r.error);
}
