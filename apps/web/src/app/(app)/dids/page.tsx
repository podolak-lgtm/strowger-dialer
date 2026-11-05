import { prisma, type CarrierVerdict } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { discrepant, provider, worst } from "@/lib/did-reputation";
import { assignNumberCampaign, bulkCheck, resolveNumber, setAutoRecheck, testNumber } from "./actions";
import { markRegistered, registerAtRegistry, setDailyCap, setRest } from "./hygiene-actions";
import { capForNumber, numbersNeeded, warmupStage } from "@strowger/shared/did-hygiene";

function VerdictCell({ v }: { v: CarrierVerdict }) {
  const style =
    v === "GOOD"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
      : v === "FLAGGED"
        ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
        : v === "SPAM" || v === "BLOCKED"
          ? "bg-red-500/15 text-red-300 border-red-500/30"
          : "bg-zinc-800 text-zinc-400 border-zinc-700";
  const label = v === "SPAM" ? "SPAM/BLOCKED" : v;
  return <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${style}`}>{label}</span>;
}

function Att({ a }: { a: string | null }) {
  const t = a === "A" ? "bg-emerald-600 text-white" : a === "B" ? "bg-amber-500 text-black" : a === "C" ? "bg-red-600 text-white" : "bg-zinc-700 text-zinc-300";
  return <span className={`inline-grid h-6 w-6 place-items-center rounded text-xs font-bold ${t}`}>{a ?? "–"}</span>;
}

function ago(d: Date | null): string {
  if (!d) return "never";
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export default async function DidsPage({ searchParams }: PageProps<"/dids">) {
  const s = await requireRole("SUPERVISOR");
  const { filter, page, msg, kind } = await searchParams;
  const f = typeof filter === "string" ? filter : "all";
  const pageN = Math.max(1, Number(page) || 1);
  const PAGE = 25;

  const [all, campaigns] = await Promise.all([
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id }, orderBy: [{ status: "asc" }, { areaCode: "asc" }], include: { campaign: { select: { name: true } } } }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const bad = (n: (typeof all)[number]) => [n.attVerdict, n.verizonVerdict, n.tmobileVerdict].some((v) => v === "SPAM" || v === "BLOCKED");
  const good = (n: (typeof all)[number]) => [n.attVerdict, n.verizonVerdict, n.tmobileVerdict].every((v) => v === "GOOD");
  const disc = (n: (typeof all)[number]) => discrepant(n.attVerdict, n.verizonVerdict, n.tmobileVerdict);
  const unknown = (n: (typeof all)[number]) => [n.attVerdict, n.verizonVerdict, n.tmobileVerdict].every((v) => v === "UNKNOWN");

  const filtered = all.filter((n) => (f === "blocked" ? bad(n) : f === "discrepant" ? disc(n) : f === "good" ? good(n) : f === "unknown" ? unknown(n) : true));
  const rows = filtered.slice((pageN - 1) * PAGE, pageN * PAGE);
  const lastSync = all.reduce<Date | null>((m, n) => (n.lastScannedAt && (!m || n.lastScannedAt > m) ? n.lastScannedAt : m), null);
  const settings = (s.tenant.settings ?? {}) as { didDailyRecheck?: boolean; fcr?: { contactEmail?: string; companyName?: string; address1?: string; city?: string; state?: string; zip?: string; website?: string; contactName?: string; contactPhone?: string; category?: string } };
  const fcr = settings.fcr ?? {};
  const fcrReady = Boolean(fcr.contactEmail && fcr.companyName && fcr.address1 && fcr.city && fcr.state && fcr.zip && fcr.website && fcr.contactName && fcr.contactPhone && fcr.category);
  const recheck = settings.didDailyRecheck ?? true;
  const vendor = provider().name;
  const unregistered = all.filter((n) => !n.registeredAt).length;
  const resting = all.filter((n) => n.restUntil && n.restUntil > new Date()).length;
  const dialsToday = all.reduce((n, x) => n + x.usedToday, 0);
  const shortToday = all.reduce((n, x) => n + x.shortCallsToday, 0);

  const stat = (label: string, value: number, tone: "zinc" | "green" | "red" | "amber") => (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        {label}
        {tone !== "zinc" ? <Badge tone={tone}>{value}</Badge> : null}
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="DID & Outbound Route Administration"
        subtitle={
          <>
            Reputation of your numbers across AT&amp;T, Verizon and T-Mobile. DIDs monitored: <b>{all.length}</b> · last sync: <b>{ago(lastSync)}</b> · vendor:{" "}
            <b>{vendor}</b>
            {vendor === "manual" ? <span className="text-amber-300"> (no reputation vendor connected yet; readings are entered by hand)</span> : null}
          </>
        }
        actions={
          <>
            <Link href="/numbers" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
              Order & provision numbers
            </Link>
            <Link href="/settings" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
              Number pool settings
            </Link>
          </>
        }
      />
      {typeof msg === "string" && msg ? <Notice kind={kind === "error" ? "error" : "ok"}>{msg}</Notice> : null}

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {stat("Total DIDs", all.length, "zinc")}
        {stat("Good status (all carriers)", all.filter(good).length, "green")}
        {stat("Blocked / spam (ATT, VZW, T-MO)", all.filter(bad).length, "red")}
        {stat("Carrier discrepancies", all.filter(disc).length, "amber")}
      </div>
      <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm">
        <div className="mb-2 flex flex-wrap items-center gap-4">
          <span className="font-semibold">Hygiene</span>
          <span className="text-zinc-400">
            Not yet registered at the Free Caller Registry: <b className={unregistered ? "text-amber-300" : "text-zinc-100"}>{unregistered}</b> (they will not dial)
          </span>
          <span className="text-zinc-400">
            Resting after a flag: <b>{resting}</b>
          </span>
          <span className="text-zinc-400">
            Dials today across the pool: <b>{dialsToday}</b> · short calls (&lt;10 s): <b className={shortToday > dialsToday * 0.3 ? "text-amber-300" : ""}>{shortToday}</b>
          </span>
          <span className="text-zinc-400">
            Pool supports about <b>{(all.filter((n) => n.status === "ACTIVE" && n.registeredAt).length * 75).toLocaleString()}</b> dials/day at the established cap; 2,000/day needs {numbersNeeded(2000)} numbers.
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Caps by number age: week 1 → 40/day, weeks 2–3 → 65/day, then 75/day, spread over 10 hours. Any spam or blocked reading pulls the number for 21 days. Local
          area codes are matched first. Short calls (hangups, voicemail drops, abandons) are what carriers punish most; keep the abandon rate low.
        </p>
        {unregistered ? (
          <div className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 p-3">
            <div className="mb-2 text-sm font-medium text-amber-200">Register {unregistered} new number{unregistered === 1 ? "" : "s"} at the Free Caller Registry (free)</div>
            <form action={registerAtRegistry} className="mb-3 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!fcrReady} className="bg-emerald-400 text-emerald-950 hover:bg-emerald-300">
                Register now, automatically
              </Button>
              <span className="text-xs text-zinc-400">
                {fcrReady ? (
                  <>
                    Fills their form with the profile in Settings, reads the verification code they email to {fcr.contactEmail} from Crossbar&apos;s inbox, uploads the numbers and submits. Takes two
                    to five minutes; leave this page open.
                  </>
                ) : (
                  <>
                    Save the{" "}
                    <Link href="/settings#fcr" className="text-sky-300 underline">
                      Free Caller Registry profile in Settings
                    </Link>{" "}
                    first (business details and a crossbar.digital contact address).
                  </>
                )}
              </span>
            </form>
            <div className="mb-1 text-xs text-zinc-500">Or by hand:</div>
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-zinc-300">
              <li>
                <a href="/api/reports/fcr" download className="text-sky-300 underline">
                  Download the upload file
                </a>{" "}
                (one number per line, the format their bulk upload takes).
              </li>
              <li>
                Open{" "}
                <a href="https://www.freecallerregistry.com/fcr/" target="_blank" rel="noreferrer" className="text-sky-300 underline">
                  freecallerregistry.com ↗
                </a>
                , verify your business email with the code they send, fill in the business details (call purpose: the campaign&apos;s business, e.g. insurance quotes requested online), then on the numbers step choose
                &quot;Upload file&quot; and pick the download. Accept the terms: you certify the business itself makes calls from these numbers.
              </li>
              <li>First Orion, Hiya and TNS each email a confirmation. Then come back and press the button below so the dialer may use them.</li>
            </ol>
            <form action={markRegistered} className="flex items-center gap-2">
              {all.filter((n) => !n.registeredAt).map((n) => (
                <input key={n.id} type="hidden" name="ids" value={n.id} />
              ))}
              <Button type="submit" variant="ghost">
                Mark all {unregistered} as registered
              </Button>
              <span className="text-xs text-zinc-500">For numbers you registered by hand.</span>
            </form>
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card title="Bulk DID check & status test">
          <form action={bulkCheck} className="space-y-3">
            <Field label="Numbers" hint="One per line or comma-separated. New numbers are added to the pool.">
              <textarea name="numbers" rows={8} className={`${inputClass} font-mono`} placeholder={"(512) 555-0143\n(415) 555-0198"} required />
            </Field>
            <Button type="submit" className="w-full bg-emerald-400 text-emerald-950 hover:bg-emerald-300">
              Verify carrier status
            </Button>
          </form>
          <form action={setAutoRecheck} className="mt-4 flex items-center justify-between text-sm">
            <input type="hidden" name="on" value={recheck ? "false" : "true"} />
            <span className="text-zinc-300">Automated daily re-check</span>
            <button type="submit" className={`relative h-6 w-11 rounded-full transition ${recheck ? "bg-emerald-500" : "bg-zinc-700"}`} title={recheck ? "On" : "Off"}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${recheck ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">Runs with the nightly sweep once a vendor is connected; numbers spam-flagged anywhere leave rotation automatically.</p>
        </Card>

        <Card
          title="Real-time DID monitoring grid"
          className="overflow-hidden"
        >
          <div className="mb-3 flex items-center justify-between text-sm">
            <div className="flex gap-1">
              {[
                ["all", "All"],
                ["blocked", "Blocked only"],
                ["discrepant", "Discrepancies"],
                ["good", "Good"],
                ["unknown", "Unchecked"],
              ].map(([k, label]) => (
                <Link key={k} href={`/dids?filter=${k}`} className={`rounded-md px-2.5 py-1 ${f === k ? "bg-zinc-100 text-zinc-900" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
                  {label}
                </Link>
              ))}
            </div>
            <div className="text-xs text-zinc-500">
              Showing {rows.length ? (pageN - 1) * PAGE + 1 : 0}–{(pageN - 1) * PAGE + rows.length} of {filtered.length}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-2 py-2">DID / phone number</th>
                  <th className="px-2 py-2">Assigned campaign</th>
                  <th className="px-2 py-2 text-center" colSpan={3}>
                    The Big Three matrix
                  </th>
                  <th className="px-2 py-2">Attestation</th>
                  <th className="px-2 py-2">Today / cap</th>
                  <th className="px-2 py-2">Last scanned</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Action</th>
                </tr>
                <tr className="text-[10px] text-zinc-600">
                  <th />
                  <th />
                  <th className="px-2 pb-1 text-center">AT&amp;T</th>
                  <th className="px-2 pb-1 text-center">Verizon</th>
                  <th className="px-2 pb-1 text-center">T-Mobile</th>
                  <th />
                  <th className="px-2 pb-1">warm-up stage</th>
                  <th />
                  <th />
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map((n) => {
                  const w = worst(n.attVerdict, n.verizonVerdict, n.tmobileVerdict);
                  return (
                    <tr key={n.id} className="align-middle">
                      <td className="px-2 py-2 font-mono text-xs">
                        {formatPhone(n.phone)}
                        <div className="text-[10px] text-zinc-500">
                          {n.areaCode} · {n.state ?? "—"}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <form action={assignNumberCampaign} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={n.id} />
                          <select name="campaignId" defaultValue={n.campaignId ?? ""} className={`${inputClass} w-40 py-1 text-xs`}>
                            <option value="">Shared pool</option>
                            {campaigns.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="text-xs text-zinc-400 hover:text-zinc-100" title="Save">
                            ✓
                          </button>
                        </form>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <VerdictCell v={n.attVerdict} />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <VerdictCell v={n.verizonVerdict} />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <VerdictCell v={n.tmobileVerdict} />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <Att a={n.attestation} />
                      </td>
                      <td className="px-2 py-2 text-xs">
                        <form action={setDailyCap} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={n.id} />
                          <span className="tabular-nums">{n.usedToday}</span>
                          <span className="text-zinc-600">/</span>
                          <input name="dailyCap" defaultValue={n.dailyCap ?? ""} placeholder={String(capForNumber(n))} className={`${inputClass} w-14 py-0.5 text-xs`} title="Daily cap; blank = automatic by age" />
                          <button type="submit" className="text-zinc-400 hover:text-zinc-100" title="Save cap">✓</button>
                        </form>
                        <div className="text-[10px] text-zinc-500">
                          {warmupStage(n)} · {n.shortCallsToday} short
                          {n.registeredAt ? "" : <span className="ml-1 text-amber-300">· not registered</span>}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-xs text-zinc-400">{ago(n.lastScannedAt)}</td>
                      <td className="px-2 py-2">
                        <Badge tone={n.status === "ACTIVE" ? "green" : n.status === "SPAM_FLAGGED" ? "red" : "amber"}>{n.status.toLowerCase().replace("_", " ")}</Badge>
                        {n.restUntil && n.restUntil > new Date() ? <div className="text-[10px] text-zinc-500">rests until {n.restUntil.toISOString().slice(0, 10)}</div> : null}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex gap-1">
                          <form action={testNumber}>
                            <input type="hidden" name="id" value={n.id} />
                            <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                              Test
                            </Button>
                          </form>
                          {n.status === "ACTIVE" ? (
                            <form action={setRest}>
                              <input type="hidden" name="id" value={n.id} />
                              <input type="hidden" name="days" value="21" />
                              <Button type="submit" variant="ghost" className="px-2 py-1 text-xs" title="Pull from rotation for 21 days">
                                Rest
                              </Button>
                            </form>
                          ) : (
                            <form action={setRest}>
                              <input type="hidden" name="id" value={n.id} />
                              <input type="hidden" name="days" value="0" />
                              <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                                Restore
                              </Button>
                            </form>
                          )}
                          {!n.registeredAt ? (
                            <form action={markRegistered}>
                              <input type="hidden" name="ids" value={n.id} />
                              <Button type="submit" variant="ghost" className="px-2 py-1 text-xs" title="Registered at the Free Caller Registry">
                                Registered
                              </Button>
                            </form>
                          ) : null}
                          <details className="relative">
                            <summary className={`cursor-pointer list-none rounded-md border px-2 py-1 text-xs ${w === "GOOD" || w === "UNKNOWN" ? "border-zinc-700 text-zinc-300" : "border-red-900 text-red-300"}`}>
                              {w === "GOOD" || w === "UNKNOWN" ? "Record" : "Resolve block"}
                            </summary>
                            <form action={resolveNumber} className="absolute right-0 z-10 mt-1 w-64 space-y-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-xl">
                              <input type="hidden" name="id" value={n.id} />
                              {(
                                [
                                  ["att", "AT&T", n.attVerdict],
                                  ["verizon", "Verizon", n.verizonVerdict],
                                  ["tmobile", "T-Mobile", n.tmobileVerdict],
                                ] as const
                              ).map(([name, label, cur]) => (
                                <label key={name} className="flex items-center justify-between gap-2">
                                  <span>{label}</span>
                                  <select name={name} defaultValue={cur} className={`${inputClass} w-32 py-1`}>
                                    {["GOOD", "FLAGGED", "SPAM", "BLOCKED", "UNKNOWN"].map((v) => (
                                      <option key={v} value={v}>
                                        {v.toLowerCase()}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ))}
                              <label className="flex items-center justify-between gap-2">
                                <span>Attestation</span>
                                <select name="attestation" defaultValue={n.attestation ?? ""} className={`${inputClass} w-32 py-1`}>
                                  <option value="">unknown</option>
                                  <option value="A">A (full)</option>
                                  <option value="B">B (partial)</option>
                                  <option value="C">C (gateway)</option>
                                </select>
                              </label>
                              <label className="flex items-center gap-2">
                                <input type="checkbox" name="backInRotation" defaultChecked={n.status !== "ACTIVE"} className="h-3.5 w-3.5" /> Put back in rotation
                              </label>
                              <Button type="submit" className="w-full">
                                Save reading
                              </Button>
                            </form>
                          </details>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-2 py-8 text-center text-sm text-zinc-500">
                      No numbers match. Add numbers with the bulk check, or under Settings.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {filtered.length > PAGE ? (
            <div className="mt-3 flex justify-end gap-2 text-xs">
              {pageN > 1 ? (
                <Link href={`/dids?filter=${f}&page=${pageN - 1}`} className="rounded border border-zinc-700 px-2 py-1">
                  ‹
                </Link>
              ) : null}
              {pageN * PAGE < filtered.length ? (
                <Link href={`/dids?filter=${f}&page=${pageN + 1}`} className="rounded border border-zinc-700 px-2 py-1">
                  ›
                </Link>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
