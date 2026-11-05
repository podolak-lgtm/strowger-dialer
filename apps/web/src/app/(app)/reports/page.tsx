import { prisma } from "@strowger/db";
import { requireClientWorkspace } from "@/lib/auth";
import { Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { byAgent, byDisposition, callRows, parseRange, summarize } from "@/lib/reports";

const hm = (sec: number) => `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const s = await requireClientWorkspace("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const q = await searchParams;
  const range = parseRange(s.tenant.id, q);
  const [rows, campaigns] = await Promise.all([callRows(range), prisma.campaign.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  const sum = summarize(rows);
  const dispos = byDisposition(rows);
  const agents = byAgent(rows);
  const qs = `from=${day(range.from)}&to=${day(range.to)}${range.campaignId ? `&campaign=${range.campaignId}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`${day(range.from)} to ${day(range.to)}${range.campaignId ? ` · ${campaigns.find((c) => c.id === range.campaignId)?.name ?? ""}` : " · all campaigns"}`}
        actions={
          <>
            <a href={`/api/reports/calls.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Calls CSV
            </a>
            <a href={`/api/reports/dispositions.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
              Dispositions CSV
            </a>
            <a href={`/api/reports/agents.csv?${qs}`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
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
        <Field label="Campaign">
          <select name="campaign" defaultValue={range.campaignId ?? ""} className={inputClass}>
            <option value="">All</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
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
            ["Dials", sum.dials],
            ["Connected", `${sum.connected} (${sum.connectRate.toFixed(1)}%)`],
            ["Contacts", sum.contacts],
            ["Sales", `${sum.sales} (${sum.closeRate.toFixed(1)}% of connected)`],
            ["Talk time", hm(sum.talkSeconds)],
            ["Voicemail", sum.voicemail],
            ["No answer / busy", sum.noAnswer],
            ["Abandoned", `${sum.abandoned} (${sum.abandonRate.toFixed(2)}%)`],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By disposition">
          <Table head={["Code", "Label", "Count", "Share"]}>
            {dispos.map((d) => (
              <tr key={d.code}>
                <Td className="font-mono text-xs">{d.code}</Td>
                <Td>{d.label}</Td>
                <Td className="tabular-nums">{d.count}</Td>
                <Td className="tabular-nums text-zinc-400">{sum.dials ? ((d.count / sum.dials) * 100).toFixed(1) : 0}%</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="By agent">
          <Table head={["Agent", "Dials", "Connected", "Contacts", "Sales", "Talk"]}>
            {agents.map((a) => (
              <tr key={a.agent}>
                <Td>{a.agent}</Td>
                <Td className="tabular-nums">{a.dials}</Td>
                <Td className="tabular-nums">{a.connected}</Td>
                <Td className="tabular-nums">{a.contacts}</Td>
                <Td className="tabular-nums text-emerald-300">{a.sales}</Td>
                <Td className="tabular-nums">{hm(a.talkSeconds)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
