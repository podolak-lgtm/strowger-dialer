import { prisma } from "@strowger/db";
import { requireRole } from "@/lib/auth";
import { Button, Card, Field, PageHeader, inputClass } from "@/components/ui";
import { deleteSkill, saveSkill, setAgentSkill, setExtension } from "../inbound/actions";

export default async function SkillsPage() {
  const s = await requireRole("SUPERVISOR");
  const [skills, people] = await Promise.all([
    prisma.skill.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { tenantId: s.tenant.id, active: true, roles: { hasSome: ["AGENT", "TEAM_LEADER", "SUPERVISOR"] } }, orderBy: [{ firstName: "asc" }, { email: "asc" }], include: { skills: true } }),
  ]);
  const nameOf = (p: { firstName: string | null; lastName: string | null; email: string }) => (p.firstName ? `${p.firstName} ${p.lastName ?? ""}`.trim() : p.email);

  return (
    <div>
      <PageHeader title="Skills & extensions" subtitle="Rate each agent 1–5 per skill; queues require minimum levels and the best-rated free agent gets the call. Extensions let callers reach an agent from an IVR." />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card title="Skills">
          <ul className="mb-3 space-y-1 text-sm">
            {skills.map((k) => (
              <li key={k.id} className="flex items-center justify-between rounded-md border border-zinc-800 px-2 py-1">
                <span>{k.name}</span>
                <form action={deleteSkill}>
                  <input type="hidden" name="id" value={k.id} />
                  <Button type="submit" variant="danger" className="px-2 py-0.5 text-xs">
                    ✕
                  </Button>
                </form>
              </li>
            ))}
            {skills.length === 0 ? <li className="text-xs text-zinc-500">None yet. Examples: Spanish, Tech support, Billing, Tier 2.</li> : null}
          </ul>
          <form action={saveSkill} className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="New skill">
                <input name="name" placeholder="Spanish" className={inputClass} required />
              </Field>
            </div>
            <Button type="submit" variant="ghost">
              Add
            </Button>
          </form>
        </Card>

        <Card title="Agents">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-2 py-2">Agent</th>
                  <th className="px-2 py-2">Extension</th>
                  {skills.map((k) => (
                    <th key={k.id} className="px-2 py-2 text-center">
                      {k.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {people.map((p) => (
                  <tr key={p.id}>
                    <td className="px-2 py-1.5">
                      {nameOf(p)}
                      <div className="text-xs text-zinc-500">{p.email}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <form action={setExtension} className="flex items-center gap-1">
                        <input type="hidden" name="userId" value={p.id} />
                        <input name="extension" defaultValue={p.extension ?? ""} placeholder="101" className={`${inputClass} w-20 py-0.5 font-mono text-xs`} />
                        <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-100" title="Save extension">
                          ✓
                        </button>
                      </form>
                    </td>
                    {skills.map((k) => {
                      const lvl = p.skills.find((x) => x.skillId === k.id)?.level ?? 0;
                      return (
                        <td key={k.id} className="px-2 py-1.5 text-center">
                          <form action={setAgentSkill} className="inline-flex items-center gap-1">
                            <input type="hidden" name="userId" value={p.id} />
                            <input type="hidden" name="skillId" value={k.id} />
                            <select name="level" defaultValue={lvl} className={`${inputClass} w-16 py-0.5 text-xs`}>
                              <option value={0}>—</option>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-100" title="Save">
                              ✓
                            </button>
                          </form>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
