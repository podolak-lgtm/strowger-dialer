import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, inputClass } from "@/components/ui";
import { deleteBox, deleteIvr, deleteQueue, saveBox, saveIvr, saveQueue, setNumberRoute } from "./actions";

const ACTIONS = ["QUEUE", "USER", "VOICEMAIL", "IVR", "HANGUP"] as const;
type IvrOption = { digit: string; label?: string; action: string; targetId?: string | null };
type Req = { skillId: string; minLevel: number };

export default async function InboundPage() {
  const s = await requireClientWorkspace("SUPERVISOR");
  const t = s.tenant.id;
  const [numbers, ivrs, queues, boxes, skills, people, campaigns, audio] = await Promise.all([
    prisma.callerIdNumber.findMany({ where: { tenantId: t }, orderBy: { phone: "asc" }, include: { ivr: true, queue: true, routeUser: true, campaign: true } }),
    prisma.ivr.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.queue.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.voicemailBox.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, include: { owner: true, _count: { select: { messages: { where: { status: "NEW" } } } } } }),
    prisma.skill.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { tenantId: t, active: true }, orderBy: [{ firstName: "asc" }, { email: "asc" }], select: { id: true, firstName: true, lastName: true, email: true, extension: true } }),
    prisma.campaign.findMany({ where: { tenantId: t, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.audioAsset.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } }),
  ]);
  const nameOf = (p: { firstName: string | null; lastName: string | null; email: string }) => (p.firstName ? `${p.firstName} ${p.lastName ?? ""}`.trim() : p.email);

  const TargetSelect = ({ name, action, value }: { name: string; action: string; value?: string | null }) => (
    <select name={name} defaultValue={value ?? ""} className={`${inputClass} py-1 text-xs`}>
      <option value="">— target —</option>
      {(action === "QUEUE" ? queues : action === "IVR" ? ivrs : []).map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
      {action === "USER" ? people.map((p) => <option key={p.id} value={p.id}>{nameOf(p)}</option>) : null}
      {action === "VOICEMAIL" ? boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>) : null}
    </select>
  );

  return (
    <div>
      <PageHeader
        title="Inbound"
        subtitle="Where each number sends a caller: a campaign (callbacks), a menu, a skills queue, or one agent's direct line. Agents' extensions and skills are on the Skills page."
        actions={
          <>
            <Link href="/skills" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Skills & extensions
            </Link>
            <Link href="/voicemails" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Voicemails
            </Link>
          </>
        }
      />

      <Card title="Number routing" className="mb-6">
        {numbers.length === 0 ? <p className="text-sm text-zinc-500">Add numbers under Settings first.</p> : null}
        <Table head={["Number", "Routes to", "Target", ""]}>
          {numbers.map((n) => (
            <tr key={n.id}>
              <td colSpan={4} className="p-0">
                <form action={setNumberRoute} className="grid grid-cols-[180px_220px_1fr_auto] items-center gap-2 px-3 py-1.5 text-sm">
                  <input type="hidden" name="id" value={n.id} />
                  <span className="font-mono text-xs">
                    {formatPhone(n.phone)}
                    <span className="ml-2 text-zinc-500">{n.state ?? ""}</span>
                  </span>
                  <select name="routeTo" defaultValue={n.routeTo} className={`${inputClass} py-1`}>
                    <option value="CAMPAIGN">Campaign callbacks{n.campaign ? ` (${n.campaign.name})` : ""}</option>
                    <option value="IVR">IVR menu</option>
                    <option value="QUEUE">Skills queue</option>
                    <option value="USER">One agent (direct DID)</option>
                  </select>
                  <select name="target" defaultValue={n.ivrId ?? n.queueId ?? n.routeUserId ?? ""} className={`${inputClass} py-1`}>
                    <option value="">— pick the IVR, queue or agent for that route —</option>
                    <optgroup label="IVRs">
                      {ivrs.map((x) => (
                        <option key={x.id} value={x.id}>
                          IVR: {x.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Queues">
                      {queues.map((x) => (
                        <option key={x.id} value={x.id}>
                          Queue: {x.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Agents">
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          Agent: {nameOf(p)}
                          {p.extension ? ` (x${p.extension})` : ""}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <Button type="submit" variant="ghost">
                    Save
                  </Button>
                </form>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="IVR menus">
          <div className="space-y-4">
            {[...ivrs, null].map((ivr) => {
              const opts = ((ivr?.options as IvrOption[] | null) ?? []);
              return (
                <form key={ivr?.id ?? "new"} action={saveIvr} className={`space-y-2 rounded-md border p-3 text-sm ${ivr ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
                  {ivr ? <input type="hidden" name="id" value={ivr.id} /> : null}
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={ivr ? "Menu" : "New menu"}>
                      <input name="name" defaultValue={ivr?.name ?? ""} placeholder="Main menu" className={inputClass} required />
                    </Field>
                    <Field label="Greeting">
                      <select name="greetingAudioId" defaultValue={ivr?.greetingAudioId ?? ""} className={inputClass}>
                        <option value="">none (silence)</option>
                        {audio.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="grid grid-cols-[32px_1fr_130px_1fr] items-center gap-1 text-xs">
                    {Array.from({ length: 10 }, (_, i) => {
                      const o = opts.find((x) => x.digit === String(i));
                      return (
                        <OptionRow key={i} i={i} o={o} TargetSelect={TargetSelect} />
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex items-center gap-1 text-xs text-zinc-300">
                      <input type="checkbox" name="allowExtensions" defaultChecked={ivr?.allowExtensions ?? true} className="h-3.5 w-3.5" /> callers may dial an extension
                    </label>
                    <Field label="Wait (s)">
                      <input name="timeoutSeconds" type="number" min="2" max="20" defaultValue={ivr?.timeoutSeconds ?? 6} className={`${inputClass} w-16 py-1`} />
                    </Field>
                    <Field label="Repeats">
                      <input name="repeats" type="number" min="0" max="5" defaultValue={ivr?.repeats ?? 2} className={`${inputClass} w-16 py-1`} />
                    </Field>
                    <Field label="Then">
                      <select name="timeoutAction" defaultValue={ivr?.timeoutAction ?? "HANGUP"} className={`${inputClass} py-1`}>
                        {ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Target">
                      <select name="timeoutTarget" defaultValue={ivr?.timeoutTargetId ?? ""} className={`${inputClass} py-1 text-xs`}>
                        <option value="">—</option>
                        {queues.map((x) => (
                          <option key={x.id} value={x.id}>
                            Queue: {x.name}
                          </option>
                        ))}
                        {boxes.map((x) => (
                          <option key={x.id} value={x.id}>
                            Voicemail: {x.name}
                          </option>
                        ))}
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            Agent: {nameOf(p)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button type="submit" variant="ghost">
                      {ivr ? "Save" : "Add menu"}
                    </Button>
                    {ivr ? (
                      <Button type="submit" variant="danger" formAction={deleteIvr}>
                        ✕
                      </Button>
                    ) : null}
                  </div>
                </form>
              );
            })}
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Skills queues">
            <div className="space-y-4">
              {[...queues, null].map((q) => {
                const req = ((q?.requiredSkills as Req[] | null) ?? []);
                return (
                  <form key={q?.id ?? "new"} action={saveQueue} className={`space-y-2 rounded-md border p-3 text-sm ${q ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
                    {q ? <input type="hidden" name="id" value={q.id} /> : null}
                    <div className="grid grid-cols-2 gap-2">
                      <Field label={q ? "Queue" : "New queue"}>
                        <input name="name" defaultValue={q?.name ?? ""} placeholder="Spanish support" className={inputClass} required />
                      </Field>
                      <Field label="Campaign context (optional)">
                        <select name="campaignId" defaultValue={q?.campaignId ?? ""} className={inputClass}>
                          <option value="">none</option>
                          {campaigns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="text-xs text-zinc-400">Required skills (all must be met):</div>
                    <div className="flex flex-wrap gap-2">
                      {skills.map((k) => {
                        const r = req.find((x) => x.skillId === k.id);
                        return (
                          <label key={k.id} className="flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs">
                            <input type="checkbox" name="skillId" value={k.id} defaultChecked={Boolean(r)} className="h-3.5 w-3.5" />
                            {k.name} ≥
                            <input name={`minLevel_${k.id}`} type="number" min="1" max="5" defaultValue={r?.minLevel ?? 3} className={`${inputClass} w-12 py-0.5 text-xs`} />
                          </label>
                        );
                      })}
                      {skills.length === 0 ? (
                        <span className="text-xs text-zinc-500">
                          No skills yet: add them on <Link href="/skills" className="underline">Skills</Link>. A queue with no skills takes any Ready agent.
                        </span>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <Field label="Hold music">
                        <select name="holdAudioId" defaultValue={q?.holdAudioId ?? ""} className={`${inputClass} py-1 text-xs`}>
                          <option value="">silence</option>
                          {audio.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Max wait (s)">
                        <input name="maxWaitSeconds" type="number" min="15" defaultValue={q?.maxWaitSeconds ?? 300} className={`${inputClass} py-1`} />
                      </Field>
                      <Field label="Then">
                        <select name="overflowAction" defaultValue={q?.overflowAction ?? "VOICEMAIL"} className={`${inputClass} py-1 text-xs`}>
                          <option value="VOICEMAIL">voicemail</option>
                          <option value="QUEUE">another queue</option>
                          <option value="HANGUP">hang up</option>
                        </select>
                      </Field>
                      <Field label="Overflow queue / box">
                        <select name="overflowQueueId" defaultValue={q?.overflowQueueId ?? ""} className={`${inputClass} py-1 text-xs`}>
                          <option value="">—</option>
                          {queues
                            .filter((x) => x.id !== q?.id)
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </div>
                    <div className="flex items-end gap-2">
                      <Field label="Voicemail box">
                        <select name="voicemailBoxId" defaultValue={q?.voicemailBoxId ?? ""} className={`${inputClass} py-1 text-xs`}>
                          <option value="">auto-create</option>
                          {boxes.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Button type="submit" variant="ghost">
                        {q ? "Save" : "Add queue"}
                      </Button>
                      {q ? (
                        <Button type="submit" variant="danger" formAction={deleteQueue}>
                          ✕
                        </Button>
                      ) : null}
                    </div>
                  </form>
                );
              })}
            </div>
          </Card>

          <Card title="Voicemail boxes">
            <div className="space-y-2">
              {[...boxes, null].map((b) => (
                <form key={b?.id ?? "new"} action={saveBox} className={`flex flex-wrap items-end gap-2 rounded-md border p-2 text-sm ${b ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
                  {b ? <input type="hidden" name="id" value={b.id} /> : null}
                  <div className="min-w-[140px] flex-1">
                    <Field label={b ? "Box" : "New box"}>
                      <input name="name" defaultValue={b?.name ?? ""} placeholder="Sales voicemail" className={`${inputClass} py-1`} required />
                    </Field>
                  </div>
                  <Field label="Owner (agent)">
                    <select name="ownerId" defaultValue={b?.ownerId ?? ""} className={`${inputClass} py-1 text-xs`}>
                      <option value="">shared</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {nameOf(p)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Greeting">
                    <select name="greetingAudioId" defaultValue={b?.greetingAudioId ?? ""} className={`${inputClass} py-1 text-xs`}>
                      <option value="">beep only</option>
                      {audio.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {b ? <Badge tone={b._count.messages ? "amber" : "zinc"}>{b._count.messages} new</Badge> : null}
                  <Button type="submit" variant="ghost">
                    {b ? "Save" : "Add"}
                  </Button>
                  {b ? (
                    <Button type="submit" variant="danger" formAction={deleteBox}>
                      ✕
                    </Button>
                  ) : null}
                </form>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function OptionRow({ i, o, TargetSelect }: { i: number; o: IvrOption | undefined; TargetSelect: (p: { name: string; action: string; value?: string | null }) => React.ReactElement }) {
  // The target list depends on the chosen action; without client state we show every target and the engine reads the one matching the action.
  return (
    <>
      <span className="text-center font-mono text-zinc-400">{i}</span>
      <input name={`opt${i}Label`} defaultValue={o?.label ?? ""} placeholder={i === 0 ? "Operator" : ""} className={`${inputClass} py-0.5 text-xs`} />
      <select name={`opt${i}Action`} defaultValue={o?.action ?? ""} className={`${inputClass} py-0.5 text-xs`}>
        <option value="">unused</option>
        {ACTIONS.map((a) => (
          <option key={a} value={a}>
            {a.toLowerCase()}
          </option>
        ))}
      </select>
      <TargetSelect name={`opt${i}Target`} action={o?.action ?? "ALL"} value={o?.targetId} />
    </>
  );
}
