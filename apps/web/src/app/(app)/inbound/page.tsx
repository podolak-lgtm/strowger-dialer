import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Field, Notice, PageHeader, Table, inputClass } from "@/components/ui";
import { aiReadiness, deleteBox, deleteIvr, saveBox, saveIvr, setNumberRoute } from "./actions";
import { GeoRoutes } from "./geo-routes";
import { QueueForm } from "./queue-form";
import { ScheduleForm } from "./schedules";

// GEO: the IVR's geo rules pick the queue; the option's target queue is the fallback.
const ACTIONS = ["QUEUE", "GEO", "USER", "VOICEMAIL", "IVR", "HANGUP"] as const;

/** Everything the page shows, read once (and the moment it was read, for the open/closed badges). */
async function load(t: string) {
  const [numbers, ivrs, queues, boxes, skills, people, campaigns, audio, schedules, geoRoutes] = await Promise.all([
    prisma.callerIdNumber.findMany({ where: { tenantId: t }, orderBy: { phone: "asc" }, include: { ivr: true, queue: true, routeUser: true, campaign: true } }),
    prisma.ivr.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.queue.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.voicemailBox.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, include: { owner: true, _count: { select: { messages: { where: { status: "NEW" } } } } } }),
    prisma.skill.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { tenantId: t, active: true }, orderBy: [{ firstName: "asc" }, { email: "asc" }], select: { id: true, firstName: true, lastName: true, email: true, extension: true } }),
    prisma.campaign.findMany({ where: { tenantId: t, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.audioAsset.findMany({ where: { tenantId: t }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } }),
    prisma.schedule.findMany({ where: { tenantId: t }, orderBy: { name: "asc" } }),
    prisma.geoRoute.findMany({ where: { tenantId: t }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  return { numbers, ivrs, queues, boxes, skills, people, campaigns, audio, schedules, geoRoutes, now: new Date() };
}
type IvrOption = { digit: string; label?: string; action: string; targetId?: string | null };

export default async function InboundPage({ searchParams }: PageProps<"/inbound">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const msg = typeof sp.msg === "string" ? sp.msg : "";
  const msgKind = sp.kind === "error" ? "error" : "ok";
  const t = s.tenant.id;
  const [{ numbers, ivrs, queues, boxes, skills, people, campaigns, audio, schedules, geoRoutes, now }, aiReady] = await Promise.all([load(t), aiReadiness()]);
  const opts = (xs: Array<{ id: string; name: string }>) => xs.map(({ id, name }) => ({ id, name }));
  const nameOf = (p: { firstName: string | null; lastName: string | null; email: string }) => (p.firstName ? `${p.firstName} ${p.lastName ?? ""}`.trim() : p.email);

  const TargetSelect = ({ name, action, value }: { name: string; action: string; value?: string | null }) => (
    <select name={name} defaultValue={value ?? ""} className={`${inputClass} py-1 text-xs`}>
      <option value="">— target —</option>
      {(action === "QUEUE" || action === "GEO" ? queues : action === "IVR" ? ivrs : []).map((x) => (
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
        subtitle="Where each number sends a caller: business hours first, then geographic rules, then its route: a campaign (callbacks), a menu, an ACD queue, or one agent's direct line. Agents' extensions and skills are on the Skills page."
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

      {msg ? (
        <div className="mb-4">
          <Notice kind={msgKind}>{msg}</Notice>
        </div>
      ) : null}

      <Card title="Number routing" className="mb-6">
        {numbers.length === 0 ? <p className="text-sm text-zinc-500">Add numbers under Settings first.</p> : null}
        <Table head={["Number", "Hours", "Routes to", "Target", ""]}>
          {numbers.map((n) => (
            <tr key={n.id}>
              <td colSpan={5} className="p-0">
                <form action={setNumberRoute} className="grid grid-cols-1 items-center gap-2 px-3 py-1.5 text-sm md:grid-cols-[160px_160px_200px_1fr_auto]">
                  <input type="hidden" name="id" value={n.id} />
                  <span className="font-mono text-xs">
                    {formatPhone(n.phone)}
                    <span className="ml-2 text-zinc-500">{n.state ?? ""}</span>
                  </span>
                  <select name="scheduleId" defaultValue={n.scheduleId ?? ""} className={`${inputClass} py-1 text-xs`}>
                    <option value="">always open</option>
                    {schedules.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <select name="routeTo" defaultValue={n.routeTo} className={`${inputClass} py-1`}>
                    <option value="CAMPAIGN">Campaign callbacks{n.campaign ? ` (${n.campaign.name})` : ""}</option>
                    <option value="IVR">IVR menu</option>
                    <option value="QUEUE">ACD queue</option>
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

      <Card title="Business hours" className="mb-6">
        <p className="mb-3 text-sm text-zinc-400">Attach a schedule to a number (above) or a queue. Closed: the greeting, then the after-hours action.</p>
        <div className="grid gap-3 lg:grid-cols-2">
          {[...schedules, null].map((x) => (
            <ScheduleForm key={x?.id ?? "new"} s={x} now={now} audio={opts(audio)} queues={opts(queues)} ivrs={opts(ivrs)} boxes={opts(boxes)} />
          ))}
        </div>
      </Card>

      <Card title="Geographic routing" className="mb-6">
        <p className="mb-3 text-sm text-zinc-400">
          By the caller&apos;s state (the lead&apos;s when we know them, else their number&apos;s) or area code. On a number the rules run before its route; on an IVR they run when the caller picks a <span className="font-mono">geo</span> option (whose own queue is the fallback). Area codes win over states; lower order first.
        </p>
        <GeoRoutes routes={geoRoutes} numbers={numbers.map((n) => ({ id: n.id, phone: n.phone }))} ivrs={opts(ivrs)} queues={opts(queues)} />
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
          <Card title="Queues" id="queues">
            <div className="space-y-3">
              {[...queues, null].map((q) => (
                <QueueForm key={q?.id ?? "new"} q={q} queues={opts(queues)} skills={opts(skills)} campaigns={campaigns} audio={opts(audio)} boxes={opts(boxes)} schedules={opts(schedules)} aiReady={aiReady} />
              ))}
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
