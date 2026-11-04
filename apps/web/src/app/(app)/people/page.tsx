import { prisma } from "@strowger/db";
import { ROLES } from "@strowger/shared";
import Link from "next/link";
import { hasRole, requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { invitePerson } from "./actions";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  SUPERVISOR: "Supervisor",
  ROOM_SUPERVISOR: "Room supervisor",
  TEAM_LEADER: "Team leader",
  AGENT: "Agent",
  AFFILIATE: "Affiliate",
};

export default async function PeoplePage() {
  const s = await requireRole("SUPERVISOR");
  const people = await prisma.user.findMany({
    where: { tenantId: s.tenant.id },
    orderBy: [{ active: "desc" }, { email: "asc" }],
    include: { campaignAgents: { include: { campaign: { select: { name: true } } } } },
  });

  return (
    <div>
      <PageHeader title="People" subtitle="Everyone who signs in. Everyone who may take or supervise calls gets a softphone line when they are created." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Table head={["Person", "Roles", "Campaigns", "Phone line", "Status"]}>
            {people.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link href={`/people/${p.id}`} className="font-medium hover:underline">
                    {p.firstName || p.lastName ? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() : p.email}
                  </Link>
                  <div className="text-xs text-zinc-500">{p.email}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {p.roles.map((r) => (
                      <Badge key={r} tone={r === "ADMIN" ? "red" : r === "AGENT" ? "blue" : "zinc"}>
                        {ROLE_LABEL[r] ?? r}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="text-xs text-zinc-400">
                  {p.campaignAgents.map((ca) => (
                    <div key={ca.campaignId}>
                      {ca.campaign.name} · {ca.agentMode.toLowerCase()}
                    </div>
                  ))}
                </Td>
                <Td className="font-mono text-xs text-zinc-400">{p.sipUsername ?? "—"}</Td>
                <Td>
                  {!p.active ? <Badge tone="red">Disabled</Badge> : p.clerkUserId ? <Badge tone="green">Active</Badge> : <Badge tone="amber">Invited</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
        <Card title="Add a person">
          <form action={invitePerson} className="space-y-3">
            <Field label="Email" hint="They sign in with this address; the first sign-in claims the account.">
              <input name="email" type="email" required className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <input name="firstName" className={inputClass} />
              </Field>
              <Field label="Last name">
                <input name="lastName" className={inputClass} />
              </Field>
            </div>
            <fieldset className="space-y-1 text-sm">
              <legend className="text-zinc-300">Roles</legend>
              {ROLES.filter((r) => r !== "AFFILIATE" && (r !== "ADMIN" || hasRole(s))).map((r) => (
                <label key={r} className="flex items-center gap-2 text-zinc-300">
                  <input type="checkbox" name="roles" value={r} defaultChecked={r === "AGENT"} className="h-4 w-4" />
                  {ROLE_LABEL[r]}
                </label>
              ))}
            </fieldset>
            <Button type="submit">Add person</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
