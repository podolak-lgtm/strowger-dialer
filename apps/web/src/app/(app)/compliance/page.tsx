import { prisma } from "@strowger/db";
import { FEDERAL_RULE, formatPhone } from "@strowger/shared";
import { hasRole, requireClientWorkspace } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { addDncNumbers, markStateRuleVerified, removeDncEntry, runScrubNow, setScrubRequired } from "./actions";
import { engine } from "@/lib/engine";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function CompliancePage() {
  const s = await requireClientWorkspace("SUPERVISOR");
  const [dncCount, dncRecent, campaigns, rules, scrubCounts, ping] = await Promise.all([
    prisma.dncEntry.count({ where: { tenantId: s.tenant.id } }),
    prisma.dncEntry.findMany({ where: { tenantId: s.tenant.id }, orderBy: { createdAt: "desc" }, take: 50, include: { campaign: { select: { name: true } } } }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.stateRule.findMany({ orderBy: { state: "asc" } }),
    prisma.lead.groupBy({ by: ["scrubStatus"], where: { tenantId: s.tenant.id }, _count: { _all: true } }),
    engine<{ scrub: boolean; telephony: boolean }>("/ping").catch(() => ({ scrub: false, telephony: false })),
  ]);
  const isAdmin = hasRole(s);
  const scrub = Object.fromEntries(scrubCounts.map((c) => [c.scrubStatus, c._count._all])) as Record<string, number>;
  const scrubRequired = Boolean((s.tenant.settings as { scrubRequired?: boolean } | null)?.scrubRequired);
  const unverified = rules.filter((r) => !r.verifiedAt).length;

  return (
    <div>
      <PageHeader title="Compliance" subtitle="Do-not-call list, and the calling-time rules the dialer enforces." />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title={
              <>
                Litigator &amp; complainer scrub · {ping.scrub ? <Badge tone="green">Crossbar connected</Badge> : <Badge tone="amber">no scrub source</Badge>}
              </>
            }
          >
            <div className="mb-3 grid grid-cols-5 gap-2 text-center text-sm">
              {(
                [
                  ["PENDING", "Pending", "amber"],
                  ["CLEAN", "Clean", "green"],
                  ["LITIGATOR", "Litigators", "red"],
                  ["DNC", "Complainers", "red"],
                  ["FAILED", "Failed", "zinc"],
                ] as const
              ).map(([k, label, tone]) => (
                <div key={k} className="rounded-md border border-zinc-800 p-2">
                  <div className="text-xl font-semibold tabular-nums">{(scrub[k] ?? 0).toLocaleString()}</div>
                  <Badge tone={tone}>{label}</Badge>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <form action={runScrubNow}>
                <Button type="submit" variant="ghost">
                  Scrub pending now
                </Button>
              </form>
              {isAdmin ? (
                <form action={setScrubRequired}>
                  <input type="hidden" name="on" value={scrubRequired ? "false" : "true"} />
                  <Button type="submit" variant={scrubRequired ? "primary" : "ghost"}>
                    {scrubRequired ? "Scrub required before dialing: ON" : "Scrub required before dialing: off"}
                  </Button>
                </form>
              ) : null}
              <span className="text-xs text-zinc-500">
                Pending leads are scrubbed every two minutes through Crossbar (own DNC, licensed TCPA Litigator List, cache, then SubscriberVerify). Litigators are blocked;
                complainers are blocked and added to the system DNC list.
              </span>
            </div>
          </Card>

          <Card title={`Do-not-call list · ${dncCount.toLocaleString()} numbers`}>
            {dncRecent.length === 0 ? (
              <p className="text-sm text-zinc-500">Empty. Numbers land here from dispositions, STOP texts, imports and this form.</p>
            ) : (
              <Table head={["Phone", "Scope", "Source", "Note", "Added", ""]}>
                {dncRecent.map((d) => (
                  <tr key={d.id}>
                    <Td className="font-mono text-xs">{formatPhone(d.phone)}</Td>
                    <Td>{d.scope === "SYSTEM" ? <Badge tone="red">System</Badge> : <Badge tone="amber">{d.campaign?.name ?? "Campaign"}</Badge>}</Td>
                    <Td className="text-xs text-zinc-400">{d.source}</Td>
                    <Td className="text-xs text-zinc-400">{d.note}</Td>
                    <Td className="text-xs text-zinc-500">{d.createdAt.toISOString().slice(0, 10)}</Td>
                    <Td>
                      {isAdmin ? (
                        <form action={removeDncEntry}>
                          <input type="hidden" name="id" value={d.id} />
                          <Button variant="danger" type="submit">
                            Remove
                          </Button>
                        </form>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title={
              <>
                Calling-time rules · {unverified > 0 ? <Badge tone="amber">{unverified} not yet verified by counsel</Badge> : <Badge tone="green">all verified</Badge>}
              </>
            }
          >
            <p className="mb-3 text-xs text-zinc-500">
              Federal baseline: {FEDERAL_RULE.startHour}:00–{FEDERAL_RULE.endHour}:00 local ({FEDERAL_RULE.citation}). State rules narrow it; the most restrictive wins. A
              rule marked unverified still applies; the flag records that counsel has not confirmed it.
            </p>
            <Table head={["State", "Hours", "Day rules", "Attempts/day", "Citation", "Verified", ""]}>
              {rules.map((r) => {
                const overrides = (r.dayOverrides ?? {}) as Record<string, { startHour: number; endHour: number } | null>;
                return (
                  <tr key={r.state}>
                    <Td className="font-semibold">{r.state}</Td>
                    <Td className="tabular-nums">
                      {r.startHour}:00–{r.endHour}:00
                    </Td>
                    <Td className="text-xs text-zinc-400">
                      {Object.entries(overrides).map(([d, o]) => (
                        <div key={d}>
                          {DAY[Number(d)]}: {o ? `${o.startHour}:00–${o.endHour}:00` : "no calls"}
                        </div>
                      ))}
                      {r.noHolidayCalls ? <div>No holiday calls</div> : null}
                    </Td>
                    <Td className="tabular-nums">{r.maxAttemptsPerDay ?? "—"}</Td>
                    <Td className="text-xs text-zinc-400">{r.citation}</Td>
                    <Td>{r.verifiedAt ? <Badge tone="green">{r.verifiedAt.toISOString().slice(0, 10)}</Badge> : <Badge tone="amber">unverified</Badge>}</Td>
                    <Td>
                      {isAdmin ? (
                        <form action={markStateRuleVerified}>
                          <input type="hidden" name="state" value={r.state} />
                          <input type="hidden" name="verified" value={r.verifiedAt ? "false" : "true"} />
                          <Button variant="ghost" type="submit">
                            {r.verifiedAt ? "Unverify" : "Mark verified"}
                          </Button>
                        </form>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </div>

        <Card title="Add to do-not-call">
          <form action={addDncNumbers} className="space-y-3">
            <Field label="Numbers" hint="One per line, or comma-separated. Any format.">
              <textarea name="numbers" rows={8} className={`${inputClass} font-mono`} placeholder={"(305) 555-0100\n212-555-0199"} required />
            </Field>
            <Field label="Scope">
              <select name="scope" className={inputClass} defaultValue="SYSTEM">
                <option value="SYSTEM">System: every campaign</option>
                <option value="CAMPAIGN">One campaign only</option>
              </select>
            </Field>
            <Field label="Campaign (for campaign scope)">
              <select name="campaignId" className={inputClass} defaultValue="">
                <option value="">—</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Note">
              <input name="note" className={inputClass} placeholder="Consumer request, 4 Nov" />
            </Field>
            <Button type="submit">Add</Button>
            <p className="text-xs text-zinc-500">Leads already loaded with these numbers are marked DNC at once.</p>
          </form>
        </Card>
      </div>
    </div>
  );
}
