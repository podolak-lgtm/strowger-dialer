import { prisma } from "@strowger/db";
import { requireRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { rightsOf } from "@/lib/rights";
import { GamesClient } from "./games-client";

export default async function GamesPage() {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const people = await prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true, roles: { hasSome: ["AGENT", "TEAM_LEADER"] } }, select: { id: true, firstName: true, email: true }, orderBy: [{ firstName: "asc" }] });
  return (
    <div>
      <PageHeader title="Games" subtitle="Bet your weekly points against each other on the numbers, and collect a card for every sale in the poker run." />
      <GamesClient meId={s.user.id} people={people.map((p) => ({ id: p.id, name: p.firstName ?? p.email.split("@")[0]! }))} canPlay={rightsOf(s).has("games")} />
    </div>
  );
}
