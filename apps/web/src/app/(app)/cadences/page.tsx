import { prisma } from "@strowger/db";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Empty, PageHeader, Table, Td } from "@/components/ui";
import { seedStandardCadences } from "./actions";

export default async function CadencesPage() {
  const s = await requireRole("SUPERVISOR");
  const cadences = await prisma.cadenceProfile.findMany({ where: { tenantId: s.tenant.id }, orderBy: [{ kind: "asc" }, { name: "asc" }], include: { lists: { select: { id: true, name: true } } } });

  return (
    <div>
      <PageHeader
        title="Cadence profiles"
        subtitle="How a list dials: speed, attempts, gaps, dayparts, and the texts around the call. Attach a profile to a list on the list's page."
        actions={
          <>
            {cadences.length === 0 ? (
              <form action={seedStandardCadences}>
                <Button type="submit" variant="ghost">
                  Create the two standard profiles
                </Button>
              </form>
            ) : null}
            <Link href="/cadences/new" className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900">
              New profile
            </Link>
          </>
        }
      />
      {cadences.length === 0 ? (
        <Empty>No cadence profiles yet. Start from the standard Fresh and Aged profiles, or create your own.</Empty>
      ) : (
        <Table head={["Profile", "Type", "Dialing", "Texts", "Lists"]}>
          {cadences.map((c) => (
            <tr key={c.id}>
              <Td>
                <Link href={`/cadences/${c.id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
              </Td>
              <Td>
                <Badge tone={c.kind === "FRESH" ? "green" : "amber"}>{c.kind === "FRESH" ? "Fresh / real-time" : "Aged"}</Badge>
              </Td>
              <Td className="text-xs text-zinc-400">
                {c.instantDial ? `Instant dial (${c.instantDelaySeconds}s after text) · ` : ""}
                {c.maxAttemptsPerDay}/day · {c.minGapMinutes >= 60 ? `${Math.round(c.minGapMinutes / 60)}h` : `${c.minGapMinutes}m`} gap
                {c.rotateDayparts ? " · rotates dayparts" : ""}
              </Td>
              <Td className="text-xs text-zinc-400">
                {[c.preCallSms ? "pre-call" : null, c.missedCallSms ? "missed-call" : null].filter(Boolean).join(", ") || "none"}
              </Td>
              <Td className="text-xs text-zinc-400">{c.lists.map((l) => l.name).join(", ") || "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
