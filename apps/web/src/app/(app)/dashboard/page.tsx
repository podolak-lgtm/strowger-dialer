import { prisma } from "@strowger/db";
import { redirect } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";

export default async function Dashboard() {
  const session = await requireClientWorkspace();
  // Agents (and team leaders) go straight to their screen; the dashboard is for people who run the floor.
  if (!session.roles.some((r) => r === "ADMIN" || r === "SUPERVISOR" || r === "ROOM_SUPERVISOR" || r === "AFFILIATE")) redirect("/agent");
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
