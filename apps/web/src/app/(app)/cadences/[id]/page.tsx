import { prisma } from "@strowger/db";
import { parseDayparts } from "@strowger/shared/cadence";
import { notFound } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";
import { Button, Card, Field, PageHeader, inputClass } from "@/components/ui";
import { deleteCadence, saveCadence } from "../actions";

export default async function CadencePage({ params }: PageProps<"/cadences/[id]">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const { id } = await params;
  const isNew = id === "new";
  const c = isNew ? null : await prisma.cadenceProfile.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!isNew && !c) notFound();
  const w = parseDayparts(c?.dayparts);

  return (
    <div>
      <PageHeader
        title={c?.name ?? "New cadence profile"}
        subtitle="Variables for texts: {{first_name}}, {{last_name}}, {{company}}, {{caller_id_number}}, {{quick_callback_link}}"
        actions={
          c ? (
            <form action={deleteCadence}>
              <input type="hidden" name="id" value={c.id} />
              <Button type="submit" variant="danger">
                Delete
              </Button>
            </form>
          ) : null
        }
      />
      <form action={saveCadence} className="grid gap-6 lg:grid-cols-2">
        {c ? <input type="hidden" name="id" value={c.id} /> : null}
        <Card title="Profile">
          <div className="space-y-3">
            <Field label="Name">
              <input name="name" required defaultValue={c?.name ?? ""} className={inputClass} placeholder="Fresh inbound (real-time)" />
            </Field>
            <Field label="Type">
              <select name="kind" defaultValue={c?.kind ?? "AGED"} className={inputClass}>
                <option value="FRESH">Fresh / real-time: posted leads, dial within seconds</option>
                <option value="AGED">Aged / standard: a few attempts a day, rotating dayparts</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="instantDial" defaultChecked={c?.instantDial ?? false} className="h-4 w-4" /> Instant dial on post (fresh only; needs a Ready agent)
            </label>
            <Field label="Seconds between the pre-call text and the dial (0–30; the standard text promises a ring within 30 seconds)">
              <input name="instantDelaySeconds" type="number" min="0" max="30" defaultValue={c?.instantDelaySeconds ?? 15} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max attempts per 24h">
                <input name="maxAttemptsPerDay" type="number" min="1" max="10" defaultValue={c?.maxAttemptsPerDay ?? 3} className={inputClass} />
              </Field>
              <Field label="Minimum gap (minutes)">
                <input name="minGapMinutes" type="number" min="5" defaultValue={c?.minGapMinutes ?? 240} className={inputClass} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="cancelRedialsOnAnswer" defaultChecked={c?.cancelRedialsOnAnswer ?? true} className="h-4 w-4" /> A live answer cancels the rest of the day&apos;s automated redials
            </label>
          </div>
        </Card>

        <Card title="Texts">
          <div className="space-y-3">
            <Field label="Pre-call text (sent from the number about to dial)">
              <textarea name="preCallSms" rows={3} defaultValue={c?.preCallSms ?? ""} className={inputClass} placeholder="Hi {{first_name}}, your phone is going to ring within the next 30 seconds from {{caller_id_number}}. If you miss us, call that number back when you're ready. Reply STOP if you'd rather not get a call." />
            </Field>
            <Field label="Missed-call text (sent when nobody answers)">
              <textarea name="missedCallSms" rows={3} defaultValue={c?.missedCallSms ?? ""} className={inputClass} placeholder="Sorry I missed you! Pick a callback time: {{quick_callback_link}}" />
            </Field>
            <p className="text-xs text-zinc-500">Texts go out only when the campaign has texting consent and an SMS-capable number. Replies and STOP handling land in Phase 5.</p>
          </div>
        </Card>

        <Card title="Dayparts (lead's local time)" className="lg:col-span-2">
          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="rotateDayparts" defaultChecked={c?.rotateDayparts ?? false} className="h-4 w-4" /> Rotate: never dial the same window on consecutive attempts
          </label>
          <div className="grid gap-3 md:grid-cols-3">
            {(
              [
                ["morning", "Morning", w.MORNING],
                ["afternoon", "Afternoon", w.AFTERNOON],
                ["evening", "Evening", w.EVENING],
              ] as const
            ).map(([k, label, [a, b]]) => (
              <div key={k} className="rounded-md border border-zinc-800 p-3">
                <div className="mb-2 text-sm font-medium">{label}</div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Start (hour, 8.5 = 8:30)">
                    <input name={`${k}Start`} type="number" step="0.25" min="0" max="24" defaultValue={a} className={inputClass} />
                  </Field>
                  <Field label="End">
                    <input name={`${k}End`} type="number" step="0.25" min="0" max="24" defaultValue={b} className={inputClass} />
                  </Field>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">State and federal calling windows still apply on top; the most restrictive wins.</p>
        </Card>

        <div className="lg:col-span-2">
          <Button type="submit">Save profile</Button>
        </div>
      </form>
    </div>
  );
}
