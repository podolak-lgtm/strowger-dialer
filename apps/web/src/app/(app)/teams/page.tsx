import { prisma } from "@strowger/db";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { assignPerson, createRoom, createTeam, deleteRoom, deleteTeam, updateRoom, updateTeam } from "./actions";

function nameOf(u: { firstName: string | null; lastName: string | null; email: string }) {
  return u.firstName ? `${u.firstName} ${u.lastName ?? ""}`.trim() : u.email;
}

export default async function TeamsPage() {
  const s = await requireClientWorkspace("SUPERVISOR");
  const [rooms, teams, people] = await Promise.all([
    prisma.room.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" }, include: { supervisor: true, members: true, teams: { select: { id: true, name: true } } } }),
    prisma.team.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" }, include: { leader: true, room: true, members: true } }),
    prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true }, orderBy: [{ firstName: "asc" }, { email: "asc" }], include: { teams: { include: { team: { select: { id: true, name: true } } } }, rooms: { include: { room: { select: { id: true, name: true } } } } } }),
  ]);
  const supervisors = people.filter((p) => p.roles.some((r) => r === "SUPERVISOR" || r === "ROOM_SUPERVISOR" || r === "ADMIN"));
  const leaders = people.filter((p) => p.roles.some((r) => r === "TEAM_LEADER" || r === "SUPERVISOR" || r === "ADMIN"));

  return (
    <div>
      <PageHeader title="Teams & rooms" subtitle="A room is a location or floor with a room supervisor. A team is a leader and the agents under them; a team may sit inside a room. Team leaders see their team on the floor; room supervisors see their room." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Rooms">
          <div className="space-y-2">
            {rooms.map((r) => (
              <form key={r.id} action={updateRoom} className="flex flex-wrap items-end gap-2 rounded-md border border-zinc-800 p-2 text-sm">
                <input type="hidden" name="id" value={r.id} />
                <div className="min-w-[140px] flex-1">
                  <Field label="Room">
                    <input name="name" defaultValue={r.name} className={inputClass} />
                  </Field>
                </div>
                <div className="min-w-[180px]">
                  <Field label="Room supervisor">
                    <select name="supervisorId" defaultValue={r.supervisorId ?? ""} className={inputClass}>
                      <option value="">none</option>
                      {supervisors.map((p) => (
                        <option key={p.id} value={p.id}>
                          {nameOf(p)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="text-xs text-zinc-500">
                  {r.members.length} people · {r.teams.length} teams
                </div>
                <Button type="submit" variant="ghost">
                  Save
                </Button>
                <Button type="submit" variant="danger" formAction={deleteRoom}>
                  ✕
                </Button>
              </form>
            ))}
            <form action={createRoom} className="flex items-end gap-2 rounded-md border border-dashed border-zinc-800 p-2 text-sm">
              <div className="flex-1">
                <Field label="New room">
                  <input name="name" placeholder="Tampa floor 2" className={inputClass} required />
                </Field>
              </div>
              <div className="min-w-[180px]">
                <Field label="Room supervisor">
                  <select name="supervisorId" className={inputClass} defaultValue="">
                    <option value="">none</option>
                    {supervisors.map((p) => (
                      <option key={p.id} value={p.id}>
                        {nameOf(p)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="submit" variant="ghost">
                Add
              </Button>
            </form>
          </div>
        </Card>

        <Card title="Teams">
          <div className="space-y-2">
            {teams.map((t) => (
              <form key={t.id} action={updateTeam} className="flex flex-wrap items-end gap-2 rounded-md border border-zinc-800 p-2 text-sm">
                <input type="hidden" name="id" value={t.id} />
                <div className="min-w-[140px] flex-1">
                  <Field label="Team">
                    <input name="name" defaultValue={t.name} className={inputClass} />
                  </Field>
                </div>
                <div className="min-w-[160px]">
                  <Field label="Team leader">
                    <select name="leaderId" defaultValue={t.leaderId ?? ""} className={inputClass}>
                      <option value="">none</option>
                      {leaders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {nameOf(p)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="min-w-[140px]">
                  <Field label="Room">
                    <select name="roomId" defaultValue={t.roomId ?? ""} className={inputClass}>
                      <option value="">none</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="text-xs text-zinc-500">{t.members.length} agents</div>
                <Button type="submit" variant="ghost">
                  Save
                </Button>
                <Button type="submit" variant="danger" formAction={deleteTeam}>
                  ✕
                </Button>
              </form>
            ))}
            <form action={createTeam} className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-zinc-800 p-2 text-sm">
              <div className="min-w-[140px] flex-1">
                <Field label="New team">
                  <input name="name" placeholder="Closers A" className={inputClass} required />
                </Field>
              </div>
              <div className="min-w-[160px]">
                <Field label="Team leader">
                  <select name="leaderId" className={inputClass} defaultValue="">
                    <option value="">none</option>
                    {leaders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {nameOf(p)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="min-w-[140px]">
                <Field label="Room">
                  <select name="roomId" className={inputClass} defaultValue="">
                    <option value="">none</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="submit" variant="ghost">
                Add
              </Button>
            </form>
          </div>
        </Card>

        <Card title="Who sits where" className="lg:col-span-2">
          <Table head={["Person", "Roles", "Team", "Room", ""]}>
            {people.map((p) => (
              <tr key={p.id}>
                <td colSpan={5} className="p-0">
                  <form action={assignPerson} className="grid grid-cols-[1fr_200px_200px_200px_auto] items-center gap-2 px-3 py-1.5 text-sm">
                    <input type="hidden" name="userId" value={p.id} />
                    <div>
                      {nameOf(p)}
                      <div className="text-xs text-zinc-500">{p.email}</div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {p.roles.map((r) => (
                        <Badge key={r}>{r.toLowerCase().replace("_", " ")}</Badge>
                      ))}
                    </div>
                    <select name="teamId" defaultValue={p.teams[0]?.teamId ?? ""} className={inputClass}>
                      <option value="">no team</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <select name="roomId" defaultValue={p.rooms[0]?.roomId ?? ""} className={inputClass}>
                      <option value="">no room</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="ghost">
                      Save
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </Table>
          {people.length === 0 ? <Td>No people yet.</Td> : null}
        </Card>
      </div>
    </div>
  );
}
