import { prisma } from "@strowger/db";
import { redirect } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";
import { ONBOARDING_WIZARD_LIVE, readOnboarding } from "@strowger/shared/onboarding";

export default async function Dashboard() {
  const session = await requireClientWorkspace();
  // Agents (and team leaders) go straight to their screen; the dashboard is for people who run the floor.
  if (!session.roles.some((r) => r === "ADMIN" || r === "SUPERVISOR" || r === "ROOM_SUPERVISOR" || r === "AFFILIATE")) redirect("/agent");
  // A client admin's first stop is the onboarding wizard (owner, 6 Nov); after the first visit it is the "Finish setup" banner.
  if (ONBOARDING_WIZARD_LIVE && session.roles.includes("ADMIN") && !session.actingFrom && !session.tenant.isPlatform) {
    const ob = readOnboarding(session.tenant.onboarding);
    if (!ob.firstSeenAt && !ob.finishedAt) redirect("/welcome");
  }
  const t = session.tenant.id;
  const [campaigns, lists, leads, users] = await Promise.all([
    prisma.campaign.count({ where: { tenantId: t } }),
    prisma.list.count({ where: { tenantId: t } }),
    prisma.lead.count({ where: { tenantId: t } }),
    prisma.user.count({ where: { tenantId: t, active: true } }),
  ]);
  const tiles = [
    ["Campaigns", campaigns],
    ["Lists", lists],
    ["Leads", leads],
    ["People", users],
  ] as const;
  return (
    <div>
      <h1 className="text-2xl font-semibold">{session.tenant.name}</h1>
      <p className="mt-1 text-sm text-zinc-400">Roles: {session.roles.join(", ")}</p>
      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map(([label, n]) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{n}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
