import { prisma } from "@strowger/db";
import { formatPhone, normalizePhone } from "@strowger/shared";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Empty, PageHeader, Table, Td, inputClass } from "@/components/ui";

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const s = await requireClientWorkspace("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const { q, id } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const phone = normalizePhone(query);

  const results = query
    ? await prisma.lead.findMany({
        where: {
          tenantId: s.tenant.id,
          OR: phone ? [{ phone }] : [{ firstName: { contains: query, mode: "insensitive" } }, { lastName: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }],
        },
        orderBy: { postedAt: "desc" },
        take: 50,
        include: { list: { select: { name: true, campaign: { select: { name: true } } } }, owner: { select: { firstName: true, email: true } } },
      })
    : [];

  const detail =
    typeof id === "string"
      ? await prisma.lead.findFirst({
          where: { id, tenantId: s.tenant.id },
          include: {
            list: { select: { name: true, campaign: { select: { name: true } } } },
            events: { orderBy: { createdAt: "desc" }, take: 40, include: { actor: { select: { firstName: true, email: true } } } },
            calls: { orderBy: { dialedAt: "desc" }, take: 20, include: { disposition: true, agent: { select: { firstName: true, email: true } } } },
            messages: { orderBy: { createdAt: "desc" }, take: 20 },
            callbacks: { orderBy: { dueAt: "desc" }, take: 5 },
          },
        })
      : null;
  const dnc = detail ? await prisma.dncEntry.findMany({ where: { tenantId: s.tenant.id, phone: detail.phone } }) : [];

  return (
    <div>
      <PageHeader title="Find a lead" subtitle="Search by phone, name or email. Everything that happened to the lead, in one place." />
      <form className="mb-6 flex gap-2">
        <input name="q" defaultValue={query} placeholder="(305) 555-0100, Ada, ada@example.com" className={`${inputClass} max-w-md`} autoFocus />
        <Button type="submit">Search</Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {query && results.length === 0 ? <Empty>No lead matches.</Empty> : null}
          {results.length ? (
            <Table head={["Lead", "Phone", "List / campaign", "Status", "Owner", "Posted"]}>
              {results.map((l) => (
                <tr key={l.id} className={l.id === id ? "bg-zinc-800/50" : ""}>
                  <Td>
                    <Link href={`/leads?q=${encodeURIComponent(query)}&id=${l.id}`} className="font-medium hover:underline">
                      {[l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown"}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      {[l.city, l.state].filter(Boolean).join(", ")}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{formatPhone(l.phone)}</Td>
                  <Td className="text-xs text-zinc-400">
                    {l.list.name}
                    {l.list.campaign ? ` · ${l.list.campaign.name}` : ""}
                  </Td>
                  <Td>
                    <Badge tone={l.status === "DNC" || l.status === "BLOCKED" ? "red" : l.status === "NEW" ? "blue" : "zinc"}>{l.status}</Badge>
                  </Td>
                  <Td className="text-xs text-zinc-400">{l.owner?.firstName ?? l.owner?.email ?? "—"}</Td>
                  <Td className="text-xs text-zinc-500">{l.postedAt.toISOString().slice(0, 10)}</Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </div>

        {detail ? (
          <Card title={`${[detail.firstName, detail.lastName].filter(Boolean).join(" ") || "Unknown"} · ${formatPhone(detail.phone)}`}>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <Badge tone={detail.status === "DNC" || detail.status === "BLOCKED" ? "red" : "zinc"}>{detail.status}</Badge>
              <Badge tone={detail.scrubStatus === "CLEAN" ? "green" : detail.scrubStatus === "PENDING" ? "amber" : "red"}>scrub: {detail.scrubStatus.toLowerCase()}</Badge>
              {dnc.length ? <Badge tone="red">on DNC ({dnc.map((d) => d.source.toLowerCase()).join(", ")})</Badge> : null}
              <span className="text-zinc-500">
                {detail.list.name}
                {detail.list.campaign ? ` · ${detail.list.campaign.name}` : ""} · zone {detail.timezone ?? "?"} · {detail.attemptsTotal} attempts
              </span>
            </div>
            <div className="mb-3 text-xs text-zinc-400">
              {[detail.address, detail.city, detail.state, detail.zip].filter(Boolean).join(", ")}
              {detail.email ? ` · ${detail.email}` : ""}
              {detail.consentTrustedFormId ? " · TrustedForm" : ""}
              {detail.consentJornayaId ? " · Jornaya" : ""}
              {detail.optInAt ? ` · opt-in ${detail.optInAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}
            </div>

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Calls</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {detail.calls.map((c) => (
                <li key={c.id} className="flex justify-between gap-2 rounded bg-zinc-950 px-2 py-1">
                  <span>
                    {c.dialedAt.toLocaleString()} · {c.direction.toLowerCase()} · {c.agent?.firstName ?? c.agent?.email ?? "dialer"}
                  </span>
                  <span className="text-zinc-400">
                    {c.outcome?.toLowerCase().replace("_", " ") ?? "—"}
                    {c.disposition ? ` · ${c.disposition.label}` : ""}
                    {c.abandoned ? " · abandoned" : ""}
                  </span>
                </li>
              ))}
              {detail.calls.length === 0 ? <li className="text-xs text-zinc-500">Never called.</li> : null}
            </ul>

            {detail.messages.length ? (
              <>
                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Texts</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {detail.messages.map((m) => (
                    <li key={m.id} className="rounded bg-zinc-950 px-2 py-1">
                      <span className="text-zinc-500">{m.createdAt.toLocaleString()}</span> {m.direction === "INBOUND" ? "←" : "→"} {m.body}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">Timeline</h3>
            <ul className="mt-1 space-y-1 text-xs text-zinc-400">
              {detail.events.map((e) => {
                const d = e.data as Record<string, unknown>;
                return (
                  <li key={e.id}>
                    <span className="text-zinc-600">{e.createdAt.toLocaleString()}</span> · {e.kind.toLowerCase().replace("_", " ")}
                    {e.actor ? ` · ${e.actor.firstName ?? e.actor.email}` : ""}
                    {d.code ? ` · ${String(d.code)}` : ""}
                    {d.note ? ` · ${String(d.note)}` : ""}
                    {d.reason ? ` · ${String(d.reason)}` : ""}
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
