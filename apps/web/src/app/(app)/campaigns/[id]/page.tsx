import { prisma } from "@strowger/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { deleteDialPlan, saveDialPlan, saveDisposition, updateCampaign } from "../actions";

function Check({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-300">
      <input type="checkbox" name={name} defaultChecked={checked} className="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
      {label}
    </label>
  );
}

export default async function CampaignPage({ params }: PageProps<"/campaigns/[id]">) {
  const s = await requireRole("SUPERVISOR");
  const { id } = await params;
  const c = await prisma.campaign.findFirst({
    where: { id, tenantId: s.tenant.id },
    include: {
      lists: { select: { id: true, name: true, totalLeads: true, dialableLeads: true, status: true, priority: true }, orderBy: { priority: "asc" } },
      dialPlans: { orderBy: [{ ageFromDays: "asc" }, { leadType: "asc" }] },
      dispositions: { orderBy: { sortOrder: "asc" } },
      _count: { select: { agents: true } },
    },
  });
  if (!c) notFound();

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={
          <>
            <Badge tone={c.status === "ACTIVE" ? "green" : c.status === "PAUSED" ? "amber" : "zinc"}>{c.status}</Badge> · {c.dialMode === "RATIO" ? `Ratio ${c.ratio.toString()}:1` : "Preview"} ·{" "}
            {c.lists.length} lists · {c._count.agents} agents
          </>
        }
      />

      <form action={updateCampaign} className="grid gap-6 lg:grid-cols-2">
        <input type="hidden" name="id" value={c.id} />

        <Card title="Basics">
          <div className="space-y-3">
            <Field label="Name">
              <input name="name" defaultValue={c.name} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                <select name="status" defaultValue={c.status} className={inputClass}>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="PAUSED">Paused</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </Field>
              <Field label="Dial mode">
                <select name="dialMode" defaultValue={c.dialMode} className={inputClass}>
                  <option value="PREVIEW">Preview</option>
                  <option value="RATIO">Ratio</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Ratio" hint="Lines per ready agent">
                <input name="ratio" type="number" step="0.1" min="1" defaultValue={c.ratio.toString()} className={inputClass} />
              </Field>
              <Field label="Max ratio">
                <input name="maxRatio" type="number" step="0.1" min="1" defaultValue={c.maxRatio.toString()} className={inputClass} />
              </Field>
              <Field label="Wrap-up (s)">
                <input name="wrapUpSeconds" type="number" min="0" defaultValue={c.wrapUpSeconds} className={inputClass} />
              </Field>
            </div>
            <Field label="Hopper order">
              <select name="hopperOrder" defaultValue={c.hopperOrder} className={inputClass}>
                <option value="LIFO">Newest first (LIFO)</option>
                <option value="FIFO">Oldest first (FIFO)</option>
                <option value="PRIORITY">By dial-plan weight</option>
              </select>
            </Field>
            <Field label="Lists of different priority" hint="Set each list's tier on its page.">
              <select name="listSelection" defaultValue={c.listSelection} className={inputClass}>
                <option value="STRICT_PRIORITY">Strict priority: tier 1 first, always</option>
                <option value="WEIGHTED_ROUND_ROBIN">Weighted round robin: 3 : 2 : 1 across tiers</option>
              </select>
            </Field>
            <Check name="closersMayDial" label="Closers may switch outbound on for themselves" checked={c.closersMayDial} />
            <Field label="Callback owner window (min)" hint="How long a callback waits for its agent before the campaign may take it.">
              <input name="callbackOwnerMinutes" type="number" min="0" defaultValue={c.callbackOwnerMinutes} className={inputClass} />
            </Field>
          </div>
        </Card>

        <Card title="Compliance">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Local window start (hour)">
                <input name="localWindowStart" type="number" min="0" max="23" defaultValue={c.localWindowStart} className={inputClass} />
              </Field>
              <Field label="Local window end (hour)">
                <input name="localWindowEnd" type="number" min="1" max="24" defaultValue={c.localWindowEnd} className={inputClass} />
              </Field>
            </div>
            <p className="text-xs text-zinc-500">Federal and state rules apply on top of this window; the most restrictive wins.</p>
            <Field label="Max attempts per phone per day" hint="Dial plans may raise this per lead age, never above the state cap. Above 3 is flagged.">
              <input name="maxAttemptsPerDay" type="number" min="1" max="10" defaultValue={c.maxAttemptsPerDay} className={inputClass} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Abandon cap %">
                <input name="abandonCapPct" type="number" step="0.1" min="0.5" max="3" defaultValue={c.abandonCapPct.toString()} className={inputClass} />
              </Field>
              <Field label="Throttle from %">
                <input name="abandonWarnPct" type="number" step="0.1" min="0.5" defaultValue={c.abandonWarnPct.toString()} className={inputClass} />
              </Field>
              <Field label="Abandon timer (ms)">
                <input name="abandonTimerMs" type="number" min="500" max="2000" defaultValue={c.abandonTimerMs} className={inputClass} />
              </Field>
            </div>
            <Check name="recordingOn" label="Record calls" checked={c.recordingOn} />
            <Check name="disclosureOn" label="Play recording disclosure when bridged" checked={c.disclosureOn} />
          </div>
        </Card>

        <Card title="Answering machines and screeners">
          <div className="space-y-3">
            <Check name="amdEnabled" label="Detect answering machines" checked={c.amdEnabled} />
            <Field label="On voicemail">
              <select name="voicemailAction" defaultValue={c.voicemailAction} className={inputClass}>
                <option value="HANGUP">Hang up</option>
                <option value="DROP">Leave the recorded voicemail message</option>
              </select>
            </Field>
            <Check name="screenerDetection" label="Detect call-screening services (Google Call Screen and the like)" checked={c.screenerDetection} />
            <Field label="When a screener answers">
              <select name="screenerAction" defaultValue={c.screenerAction} className={inputClass}>
                <option value="MESSAGE">Play the recorded name-and-reason message</option>
                <option value="AGENT">Hand the call to an agent</option>
                <option value="HANGUP">Hang up</option>
              </select>
            </Field>
            <p className="text-xs text-zinc-500">Audio files for voicemail drop, screener message, safe-harbor and disclosure are uploaded under Settings → Audio (Phase 2).</p>
          </div>
        </Card>

        <Card title="Caller ID">
          <div className="space-y-3">
            <Field label="Mode">
              <select name="callerIdMode" defaultValue={c.callerIdMode} className={inputClass}>
                <option value="LOCAL_PRESENCE">Local presence: rotate numbers matching the lead&apos;s area code</option>
                <option value="FIXED">One fixed number</option>
              </select>
            </Field>
            <Field label="Fixed number" hint="Used only in fixed mode.">
              <input name="fixedCallerId" defaultValue={c.fixedCallerId ?? ""} className={inputClass} placeholder="(305) 555-0100" />
            </Field>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <Button type="submit">Save campaign</Button>
        </div>
      </form>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Lists in this campaign">
          {c.lists.length === 0 ? (
            <p className="text-sm text-zinc-500">
              None. Assign lists from the <Link href="/lists" className="underline">Lists</Link> page.
            </p>
          ) : (
            <Table head={["List", "Leads", "Dialable", "Status"]}>
              {c.lists.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <Link href={`/lists/${l.id}`} className="hover:underline">
                      {l.name}
                    </Link>
                    <span className="ml-2 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">P{l.priority}</span>
                  </Td>
                  <Td className="tabular-nums">{l.totalLeads.toLocaleString()}</Td>
                  <Td className="tabular-nums">{l.dialableLeads.toLocaleString()}</Td>
                  <Td>
                    <Badge tone={l.status === "ACTIVE" ? "green" : "amber"}>{l.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Dial plans by lead age">
          <p className="mb-3 text-xs text-zinc-500">
            How often a lead is tried depending on how old it is (days since it was posted) and its lead type. The state&apos;s cap always wins.
          </p>
          <div className="space-y-2">
            {c.dialPlans.map((p) => (
              <form key={p.id} action={saveDialPlan} className="grid grid-cols-[1fr_60px_60px_60px_70px_50px_auto_auto] items-end gap-2 rounded-md border border-zinc-800 p-2 text-xs">
                <input type="hidden" name="campaignId" value={c.id} />
                <input type="hidden" name="planId" value={p.id} />
                <Field label="Lead type">
                  <input name="leadType" defaultValue={p.leadType ?? ""} placeholder="any" className={inputClass} />
                </Field>
                <Field label="From d">
                  <input name="ageFromDays" type="number" min="0" defaultValue={p.ageFromDays} className={inputClass} />
                </Field>
                <Field label="To d">
                  <input name="ageToDays" type="number" min="0" defaultValue={p.ageToDays ?? ""} placeholder="∞" className={inputClass} />
                </Field>
                <Field label="Per day">
                  <input name="attemptsPerDay" type="number" min="1" max="10" defaultValue={p.attemptsPerDay} className={inputClass} />
                </Field>
                <Field label="Gap min">
                  <input name="retryGapMinutes" type="number" min="5" defaultValue={p.retryGapMinutes} className={inputClass} />
                </Field>
                <Field label="Weight">
                  <input name="weight" type="number" defaultValue={p.weight} className={inputClass} />
                </Field>
                <Button type="submit" variant="ghost">
                  Save
                </Button>
                <Button type="submit" variant="danger" formAction={deleteDialPlan}>
                  ✕
                </Button>
              </form>
            ))}
            <form action={saveDialPlan} className="grid grid-cols-[1fr_60px_60px_60px_70px_50px_auto] items-end gap-2 rounded-md border border-dashed border-zinc-800 p-2 text-xs">
              <input type="hidden" name="campaignId" value={c.id} />
              <Field label="Lead type">
                <input name="leadType" placeholder="any" className={inputClass} />
              </Field>
              <Field label="From d">
                <input name="ageFromDays" type="number" min="0" defaultValue={0} className={inputClass} />
              </Field>
              <Field label="To d">
                <input name="ageToDays" type="number" min="0" placeholder="∞" className={inputClass} />
              </Field>
              <Field label="Per day">
                <input name="attemptsPerDay" type="number" min="1" max="10" defaultValue={3} className={inputClass} />
              </Field>
              <Field label="Gap min">
                <input name="retryGapMinutes" type="number" min="5" defaultValue={180} className={inputClass} />
              </Field>
              <Field label="Weight">
                <input name="weight" type="number" defaultValue={0} className={inputClass} />
              </Field>
              <Button type="submit" variant="ghost">
                Add
              </Button>
            </form>
          </div>
        </Card>

        <Card title="Dispositions" className="lg:col-span-2">
          <Table head={["Code", "Label", "Key", "Contact", "Sale", "Callback", "DNC", "Recycle after (min)", ""]}>
            {c.dispositions.map((d) => (
              <tr key={d.id}>
                <td colSpan={9} className="p-0">
                  <form action={saveDisposition} className="grid grid-cols-[90px_1fr_50px_70px_60px_80px_60px_120px_auto] items-center gap-2 px-3 py-1.5 text-sm">
                    <input type="hidden" name="campaignId" value={c.id} />
                    <input type="hidden" name="dispositionId" value={d.id} />
                    <input name="code" defaultValue={d.code} className={`${inputClass} font-mono`} />
                    <input name="label" defaultValue={d.label} className={inputClass} />
                    <input name="hotkey" defaultValue={d.hotkey ?? ""} maxLength={1} className={inputClass} />
                    <input type="checkbox" name="isContact" defaultChecked={d.isContact} className="h-4 w-4 justify-self-center" />
                    <input type="checkbox" name="isSale" defaultChecked={d.isSale} className="h-4 w-4 justify-self-center" />
                    <input type="checkbox" name="isCallback" defaultChecked={d.isCallback} className="h-4 w-4 justify-self-center" />
                    <input type="checkbox" name="isDnc" defaultChecked={d.isDnc} className="h-4 w-4 justify-self-center" />
                    <input name="recycleAfterMinutes" type="number" min="1" defaultValue={d.recycleAfterMinutes ?? ""} placeholder="final" className={inputClass} />
                    <Button type="submit" variant="ghost">
                      Save
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={9} className="p-0">
                <form action={saveDisposition} className="grid grid-cols-[90px_1fr_50px_70px_60px_80px_60px_120px_auto] items-center gap-2 border-t border-dashed border-zinc-800 px-3 py-1.5 text-sm">
                  <input type="hidden" name="campaignId" value={c.id} />
                  <input name="code" placeholder="CODE" className={`${inputClass} font-mono`} />
                  <input name="label" placeholder="New disposition" className={inputClass} />
                  <input name="hotkey" maxLength={1} className={inputClass} />
                  <input type="checkbox" name="isContact" className="h-4 w-4 justify-self-center" />
                  <input type="checkbox" name="isSale" className="h-4 w-4 justify-self-center" />
                  <input type="checkbox" name="isCallback" className="h-4 w-4 justify-self-center" />
                  <input type="checkbox" name="isDnc" className="h-4 w-4 justify-self-center" />
                  <input name="recycleAfterMinutes" type="number" min="1" placeholder="final" className={inputClass} />
                  <Button type="submit" variant="ghost">
                    Add
                  </Button>
                </form>
              </td>
            </tr>
          </Table>
        </Card>
      </div>
    </div>
  );
}
