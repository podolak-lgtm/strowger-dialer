import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { hasRole, requireRole } from "@/lib/auth";
import { Badge, Button, Empty, PageHeader, Table, Td } from "@/components/ui";
import { setVoicemailStatus } from "../inbound/actions";

export default async function VoicemailsPage() {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const all = hasRole(s, "SUPERVISOR");
  const rows = await prisma.voicemail.findMany({
    where: { tenantId: s.tenant.id, status: { not: "DONE" }, ...(all ? {} : { OR: [{ assigneeId: s.user.id }, { box: { ownerId: s.user.id } }] }) },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { box: { select: { name: true, owner: { select: { firstName: true, email: true } } } } },
  });

  return (
    <div>
      <PageHeader title="Voicemails" subtitle={all ? "Every box in the workspace." : "Messages left in your box."} />
      {rows.length === 0 ? (
        <Empty>No open voicemails.</Empty>
      ) : (
        <Table head={["Received", "From", "Box", "Length", "Message", "Status", ""]}>
          {rows.map((v) => (
            <tr key={v.id}>
              <Td className="text-xs text-zinc-400">{v.createdAt.toLocaleString()}</Td>
              <Td className="font-mono text-xs">{formatPhone(v.fromPhone)}</Td>
              <Td className="text-xs text-zinc-400">
                {v.box.name}
                {v.box.owner ? ` · ${v.box.owner.firstName ?? v.box.owner.email}` : ""}
              </Td>
              <Td className="tabular-nums">{v.durationSec ? `${v.durationSec}s` : "—"}</Td>
              <Td>{v.recordingUrl ? <audio controls preload="none" src={v.recordingUrl} className="h-8" /> : <span className="text-xs text-zinc-500">recording unavailable</span>}</Td>
              <Td>
                <Badge tone={v.status === "NEW" ? "amber" : "zinc"}>{v.status.toLowerCase()}</Badge>
              </Td>
              <Td>
                <div className="flex gap-1">
                  {v.status === "NEW" ? (
                    <form action={setVoicemailStatus}>
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="status" value="LISTENED" />
                      <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                        Heard
                      </Button>
                    </form>
                  ) : null}
                  <form action={setVoicemailStatus}>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="status" value="DONE" />
                    <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                      Done
                    </Button>
                  </form>
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
