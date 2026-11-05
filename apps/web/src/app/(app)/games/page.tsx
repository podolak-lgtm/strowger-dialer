import { prisma } from "@strowger/db";
import { requireClientWorkspace } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { canManageGames, rightsOf } from "@/lib/rights";
import { GamesClient } from "./games-client";

export default async function GamesPage({ searchParams }: PageProps<"/games">) {
  const s = await requireClientWorkspace("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const { campaign } = await searchParams;
  const people = await prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true, roles: { hasSome: ["AGENT", "TEAM_LEADER"] } }, select: { id: true, firstName: true, email: true }, orderBy: [{ firstName: "asc" }] });
  return (
    <div>
      <PageHeader title="Games" subtitle="Bets and poker runs are switched on per campaign. Bet your weekly points against each other on the numbers; collect a card for every qualifying outcome in the campaign's poker run." />
      <GamesClient meId={s.user.id} people={people.map((p) => ({ id: p.id, name: p.firstName ?? p.email.split("@")[0]! }))} canPlay={rightsOf(s).has("games")} canManage={canManageGames(s)} initialCampaignId={typeof campaign === "string" ? campaign : null} />
    </div>
  );
}
