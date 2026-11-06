import { prisma } from "@strowger/db";
import { requireClientWorkspace } from "@/lib/auth";
import { Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { inboundReport } from "@/lib/inbound-report";
import { parseRange } from "@/lib/reports";

const day = (d: Date) => d.toISOString().slice(0, 10);
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const hm = (sec: number) => `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;

export default async function InboundReportPage({ searchParams }: PageProps<"/reports/inbound">) {
  const s = await requireClientWorkspace("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const q = await searchParams;
  const range = parseRange(s.tenant.id, q);
  const queueId = typeof q.queue === "string" && q.queue ? q.queue : null;
  const [rep, queues] = await Promise.all([inboundReport(range, queueId), prisma.queue.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  const o = rep.overall;
  const qs = `from=${day(range.from)}&to=${day(range.to)}${queueId ? `&queue=${queueId}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Inbound"
        subtitle={`${day(range.from)} to ${day(range.to)} · ${queueId ? (queues.find((x) => x.id === queueId)?.name ?? "") : "all queues"}. Service level counts answers within each queue's target over every caller who entered.`}
        actions={
          <>
            <a href={`/api/reports/inbound.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Calls CSV
            </a>
            <a href={`/api/reports/inbound-queues.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Queues CSV
            </a>
            <a href={`/api/reports/inbound-agents.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Agents CSV
            </a>
          </>
        }
      />

      <form className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="From">
          <input type="date" name="from" defaultValue={day(range.from)} className={inputClass} />
        </Field>
        <Field label="To">
          <input type="date" name="to" defaultValue={day(range.to)} className={inputClass} />
        </Field>
        <Field label="Queue">
          <select name="queue" defaultValue={queueId ?? ""} className={inputClass}>
            <option value="">All</option>
            {queues.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="ghost">
          Apply
        </Button>
      </form>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        {(
          [
            ["Offered", o.offered],
            ["Answered", o.answered],
            ["Service level", `${o.serviceLevelPct}%`],
            ["ASA", o.asaAfterHoldSeconds !== o.asaSeconds ? `${mmss(o.asaSeconds)} · ${mmss(o.asaAfterHoldSeconds)} after hold` : mmss(o.asaSeconds)],
            ["Abandoned", `${o.abandoned - o.abandonedInForcedHold} (${o.abandonRatePct}%)`],
            ["Abandoned in forced hold", `${o.abandonedInForcedHold} (${o.forcedHoldDropPct}%)`],
            ["AHT (talk + wrap)", mmss(o.ahtSeconds)],
            ["Longest wait", mmss(o.longestWaitSeconds)],
            ["First-call resolution", `${o.fcrPct}%`],
            ["Occupancy", `${rep.occupancyPct}% · idle ${hm(rep.idleSeconds)}`],
            ["Callbacks", `${rep.callbacks.requested} asked · ${rep.callbacks.done} done · ${rep.callbacks.failed} failed`],
            ["Survey", o.surveyAvg === null ? "—" : `${o.surveyAvg} / 5 (${o.surveys})`],
            ["Overflowed", o.overflowed],
            ...(rep.ai.handled
              ? ([
                  ["AI answered", `${rep.ai.handled} · ${rep.ai.resolved} resolved`],
                  ["AI containment", `${rep.ai.containmentPct}% (${rep.ai.contained} without a person)`],
                  ["AI hand-offs", `${rep.ai.handoffs} · ${rep.ai.messages} messages · ${rep.ai.callbacks} callbacks`],
                  ["AI minutes", `${rep.ai.aiMinutes} · avg ${rep.ai.avgAiMinutes}`],
                ] as const)
              : []),
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card title="By queue">
          <Table head={["Queue", "Offered", "Answered", "SL", "ASA", "Abandon", "In forced hold", "AHT", "Longest", "FCR", "Callbacks", "Survey", "AI"]}>
            {rep.byQueue.map((x) => (
              <tr key={x.queueId}>
                <Td>{x.name}</Td>
                <Td className="tabular-nums">{x.offered}</Td>
                <Td className="tabular-nums">{x.answered}</Td>
                <Td className="tabular-nums">
                  {x.serviceLevelPct}% <span className="text-xs text-zinc-500">in {x.slaSeconds}s</span>
                </Td>
                <Td className="tabular-nums">{mmss(x.asaSeconds)}</Td>
                <Td className="tabular-nums">{x.abandonRatePct}%</Td>
                <Td className="tabular-nums">
                  {x.abandonedInForcedHold} <span className="text-xs text-zinc-500">({x.forcedHoldDropPct}%)</span>
                </Td>
                <Td className="tabular-nums">{mmss(x.ahtSeconds)}</Td>
                <Td className="tabular-nums">{mmss(x.longestWaitSeconds)}</Td>
                <Td className="tabular-nums">{x.fcrPct}%</Td>
                <Td className="tabular-nums">
                  {x.callbacksRequested} / {x.callbacksDone}
                </Td>
                <Td className="tabular-nums">{x.surveyAvg ?? "—"}</Td>
                <Td className="tabular-nums">
                  {x.ai.handled ? (
                    <>
                      {x.ai.handled} · {x.ai.containmentPct}% <span className="text-xs text-zinc-500">contained · {x.ai.handoffs} to people · avg {x.ai.avgAiMinutes} min</span>
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="By agent">
          <Table head={["Agent", "Answered", "AHT", "Talk", "Wrap", "Occupancy", "Idle", "Survey"]}>
            {rep.agents.map((a) => (
              <tr key={a.agentId}>
                <Td>{a.agent}</Td>
                <Td className="tabular-nums">{a.answered}</Td>
                <Td className="tabular-nums">{mmss(a.ahtSeconds)}</Td>
                <Td className="tabular-nums">{hm(a.talkSeconds)}</Td>
                <Td className="tabular-nums">{hm(a.wrapSeconds)}</Td>
                <Td className="tabular-nums">{a.occupancyPct}%</Td>
                <Td className="tabular-nums">{hm(a.idleSeconds)}</Td>
                <Td className="tabular-nums">{a.surveyAvg ?? "—"}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
