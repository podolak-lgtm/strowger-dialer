import { prisma } from "@strowger/db";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import Link from "next/link";
import { balanceLow } from "@strowger/shared/accounting";
import { createWorkspace, deleteFixedCost, moveCampaignToWorkspace, openWorkspace, platformAccounting, platformOverview, recordPayment, saveAccountingSettings, saveFixedCost, savePlan, saveRates, saveVendorAccount, syncVendorCosts } from "@/lib/billing-actions";
import { money } from "@/components/billing-badge";
import { Badge, Button, Card, Field, Notice, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { platformReferrals } from "@/lib/referral-actions";
import { ReferralsCard } from "./referrals-card";
import { PnlTable } from "./pnl-table";

// The owner's view (platform workspace only), in tabs:
//   Accounting  revenue, cost, margin for the month; P&L per client; vendor spend this month and last; balances; CSV
//   Clients     balances, record a payment, open a client, new workspace, move a campaign
//   Costs       fixed monthly costs, allocation rule and margin floor, fallback cost rates
//   Plans       each client's rate plan
//   Referrals   commission and the free trial

const cents = (c: number) => money(c);
const toMilli = (m: number) => (m / 1000).toFixed(2);
const VENDOR_KIND: Record<string, string> = {
  "sip-trunking": "Calls",
  messaging: "Texts",
  number: "Numbers (monthly rental)",
  amd: "Answering-machine detection",
  conference: "Conferences",
  "conference-participant": "Conference legs",
  "call-control": "Call control",
  recording: "Recordings",
  media_storage: "Media storage",
  "media-streaming": "Media streaming",
  webrtc: "WebRTC",
  stt: "Speech to text",
  tts: "Text to speech",
  "stt.lead": "Live transcription, lead side",
  "stt.agent": "Live transcription, agent side",
  "ai.minutes": "AI answer speech minutes",
  "ai.voice": "AI answer (LLM, estimated tokens)",
  "ai.classify": "AI: reading text replies",
  "ai.assist": "AI: agent assist",
  "ai.live_assist": "AI: live assist",
  "ai.call_summary": "AI: call summaries",
  "ai.summary": "AI: hand-off summaries",
  "ai.prompt_test": "AI: prompt tests",
  scrub: "Litigator / DNC scrub",
  subscription: "Subscription",
  hosting: "Hosting",
  auth: "Sign-in",
  "10dlc": "10DLC fees",
};
const SOURCE: Record<string, { label: string; tone: "green" | "blue" | "amber" | "zinc" }> = {
  api: { label: "API", tone: "green" },
  usage: { label: "per use", tone: "blue" },
  estimate: { label: "estimate", tone: "amber" },
  fixed: { label: "fixed", tone: "zinc" },
};
const TABS = [
  ["accounting", "Accounting"],
  ["clients", "Clients"],
  ["costs", "Costs"],
  ["plans", "Plans"],
  ["referrals", "Referrals"],
] as const;
type Tab = (typeof TABS)[number][0];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
const fine = (millicents: number) => (millicents > 0 && millicents < 1000 ? "<$0.01" : cents(Math.round(millicents / 1000)));

export default async function PlatformPage({ searchParams }: PageProps<"/platform">) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) redirect("/dashboard");
  const sp = await searchParams;
  const period = typeof sp.period === "string" ? sp.period : undefined;
  const msg = typeof sp.msg === "string" ? sp.msg : null;
  const kind = sp.kind === "error" ? "error" : "ok";
  const tab: Tab = TABS.some(([k]) => k === sp.tab) ? (sp.tab as Tab) : "accounting";
  const [o, a, refs, campaigns] = await Promise.all([platformOverview(period), platformAccounting(period), platformReferrals(), prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  const lowVendors = a.accounts.filter((x) => balanceLow(x.balanceCents, x.lowBalanceCents));
  const failing = a.accounts.filter((x) => x.lastError);
  const href = (t: Tab) => `/platform?tab=${t}${period ? `&period=${period}` : ""}`;
  const platformTenantId = s.actingFrom?.id ?? s.tenant.id;
  // No client opened yet: offer the one they used last (or the only one),
  // but never enter it silently; the owner still chooses.
  const bare = !s.actingFrom;
  const remembered = bare ? o.tenants.find((t) => t.id === s.user.lastWorkspaceId) : undefined;
  const suggested = remembered ?? (bare && o.tenants.length === 1 ? o.tenants[0] : undefined);
  const sentHere = sp.pick === "1";

  return (
    <div>
      <PageHeader title="Platform" subtitle={`Every client, ${a.period}. Revenue is what clients were charged; cost is every vendor's charge to us, from their APIs where they have one, per use at list price or our rate, and the fixed monthly costs entered under Costs.`} />
      {msg ? <Notice kind={kind}>{msg}</Notice> : null}
      {sentHere ? <Notice kind="warn">That page belongs to a client workspace. Pick a client below to work on their campaigns, lists and numbers.</Notice> : null}
      {suggested ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-sky-700/60 bg-sky-950/40 p-5">
          <div>
            <div className="text-xs uppercase tracking-wide text-sky-300">{remembered ? "Where you were last" : "Your only client"}</div>
            <div className="mt-1 text-xl font-semibold text-white">{suggested.name}</div>
            <div className="mt-0.5 text-xs text-sky-200/70">You are in the platform workspace, which has no campaigns of its own. Open a client to work on theirs.</div>
          </div>
          <form action={openWorkspace}>
            <input type="hidden" name="tenantId" value={suggested.id} />
            <Button type="submit" className="px-5 py-2.5 text-base">
              Continue in {suggested.name} →
            </Button>
          </form>
        </div>
      ) : null}
      <nav aria-label="Platform" className="-mt-1 mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-zinc-800">
        <div className="flex flex-wrap gap-x-1">
          {TABS.map(([k, label]) => (
            <Link key={k} href={href(k)} aria-current={tab === k ? "page" : undefined} className={`-mb-px border-b-2 px-2.5 py-2 text-sm ${tab === k ? "border-sky-400 font-medium text-sky-500" : "border-transparent text-zinc-400 hover:text-zinc-500"}`}>
              {label}
            </Link>
          ))}
        </div>
        <form action="/platform" className="mb-1.5 flex items-center gap-2 text-xs">
          <input type="hidden" name="tab" value={tab} />
          <label htmlFor="period" className="text-zinc-500">
            Month
          </label>
          <input id="period" type="month" name="period" defaultValue={a.period} className={`${inputClass} w-40 py-1 text-xs`} />
          <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
            Show
          </Button>
        </form>
      </nav>

      {lowVendors.length > 0 ? <Notice kind="warn">Low balance: {lowVendors.map((x) => `${x.label} ${x.balanceCents === null ? "" : cents(x.balanceCents)}`).join(", ")}. Top up before calls or texts stop.</Notice> : null}

      {tab === "accounting" ? (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-4">
            {[
              ["Revenue", cents(a.top.revenueCents), "Charged to clients"],
              ["Cost", cents(a.top.costCents), "Everything every vendor charged us"],
              ["Gross margin", cents(a.top.marginCents), a.top.marginCents < 0 ? "text-red-300" : "text-emerald-300"],
              ["Margin %", a.top.marginPct === null ? "—" : `${a.top.marginPct}%`, a.top.marginPct !== null && a.top.marginPct < a.settings.marginFloorPct ? "text-red-300" : "text-emerald-300"],
            ].map(([l, val, note]) => (
              <div key={l} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">
                  {l}, {a.period}
                </div>
                <div className={`mt-1 text-2xl font-semibold tabular-nums ${note?.startsWith("text-") ? note : ""}`}>{val}</div>
                {note && !note.startsWith("text-") ? <div className="mt-0.5 text-xs text-zinc-500">{note}</div> : null}
              </div>
            ))}
          </div>

          <Card title={`Profit by client, ${a.period}`}>
            <div className="-mt-2 mb-2 flex justify-end text-xs">
              <a href={`/api/platform/export?what=clients&period=${a.period}`} className="text-sky-400 hover:underline">
                Download CSV
              </a>
            </div>
            <PnlTable rows={a.clients} floorPct={a.settings.marginFloorPct} rule={a.settings.costAllocation} />
            <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-zinc-400 md:grid-cols-2">
              <div>
                Clients together: revenue <b className="tabular-nums">{cents(a.clientTotals.revenueCents)}</b>, cost <b className="tabular-nums">{cents(a.clientTotals.costCents)}</b>, margin <b className="tabular-nums">{a.clientTotals.marginPct === null ? "—" : `${a.clientTotals.marginPct}%`}</b>
              </div>
              <div>
                Shared fixed costs <b className="tabular-nums">{cents(a.sharedFixedCents)}</b> and unmatched usage <b className="tabular-nums">{cents(a.unattributedCents)}</b> are spread by <b>{a.settings.costAllocation === "SEATS" ? "seats" : "minutes"}</b>
                {a.settings.allocateUnattributed ? "" : " (fixed only; unmatched usage is not spread)"}.
              </div>
              <div>
                Not carried by any client: <b className="tabular-nums">{cents(a.unallocatedCents)}</b> (no client used anything to spread it by{a.settings.allocateUnattributed ? "" : ", or unmatched usage"})
              </div>
              <div>
                Platform workspace&rsquo;s own use (test calls, its numbers): <b className="tabular-nums">{cents(a.platformOwnCents)}</b>
              </div>
            </div>
          </Card>

          <Card className="mt-6" title={`What the vendors charged us: ${a.period} and ${a.lastPeriod}`}>
            <div className="-mt-2 mb-2 flex items-center justify-end gap-3 text-xs">
              <a href={`/api/platform/export?what=vendors&period=${a.period}`} className="text-sky-400 hover:underline">
                Download CSV
              </a>
              <form action={syncVendorCosts}>
                <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                  Sync now
                </Button>
              </form>
            </div>
            <Table head={["Vendor", "What", "Source", "Records", "Quantity", a.period, a.lastPeriod]}>
              {a.vendors.map((r) => (
                <tr key={`${r.vendor}:${r.kind}:${r.source}`}>
                  <Td className="capitalize">{r.vendor}</Td>
                  <Td>{VENDOR_KIND[r.kind] ?? r.kind}</Td>
                  <Td>
                    <Badge tone={SOURCE[r.source]?.tone ?? "zinc"}>{SOURCE[r.source]?.label ?? r.source}</Badge>
                  </Td>
                  <Td className="tabular-nums">{r.records.toLocaleString()}</Td>
                  <Td className="tabular-nums text-zinc-400">{r.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })}</Td>
                  <Td className="tabular-nums">{fine(r.thisMillicents)}</Td>
                  <Td className="tabular-nums text-zinc-400">{cents(r.lastCents)}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-medium">Total</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td>{""}</Td>
                <Td className="font-semibold tabular-nums">{cents(a.vendorTotals.thisCents)}</Td>
                <Td className="tabular-nums text-zinc-400">{cents(a.vendorTotals.lastCents)}</Td>
              </tr>
            </Table>
            <p className="mt-2 text-xs text-zinc-500">
              <b>API</b>: the vendor&rsquo;s own records (Telnyx calls matched by direction, number and start time; texts by message id; the jambonz invoice). <b>Per use</b>: counted by us and priced at list price or the rate under Costs (AI tokens, speech minutes, text-to-speech characters, numbers, scrubs). <b>Estimate</b>: a call or text at our rate until its Telnyx record arrives, then replaced. <b>Fixed</b>: entered under Costs. Usage syncs hourly, balances daily.
            </p>
          </Card>

          <Card title="Vendor balances" className="mt-6" id="balances">
            {failing.length > 0 ? (
              <Notice kind="error">
                {failing.map((x) => (
                  <div key={x.vendor}>
                    {x.label}: {x.lastError} ({when(x.lastErrorAt)})
                  </div>
                ))}
              </Notice>
            ) : null}
            <Table head={["Vendor", "How we get it", "Balance", "Their figure for the month", "Last sync", "Warn below / balance"]}>
              {a.accounts.map((x) => {
                const low = balanceLow(x.balanceCents, x.lowBalanceCents);
                const manual = x.vendor !== "telnyx";
                return (
                  <tr key={x.vendor}>
                    <Td>
                      <div className="font-medium">{x.label}</div>
                      {x.note ? <div className="text-xs text-zinc-500">{x.note}</div> : null}
                    </Td>
                    <Td className="max-w-xs text-xs text-zinc-400">{x.api}</Td>
                    <Td className={`tabular-nums ${low ? "font-semibold text-red-300" : ""}`}>
                      {x.balanceCents === null ? "—" : cents(x.balanceCents)}
                      {x.balanceCents !== null ? <div className="text-xs font-normal text-zinc-500">{x.balanceSource === "manual" ? "entered" : "from the API"} {when(x.balanceAt)}</div> : null}
                    </Td>
                    <Td className="tabular-nums text-xs text-zinc-400">{x.reportedCents === null ? "—" : `${cents(x.reportedCents)} (${x.reportedPeriod})`}</Td>
                    <Td className="text-xs text-zinc-400">{when(x.usageSyncedAt ?? x.balanceAt)}</Td>
                    <Td>
                      <form action={saveVendorAccount} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="vendor" value={x.vendor} />
                        <input name="low" defaultValue={x.lowBalanceCents === null ? "" : (x.lowBalanceCents / 100).toFixed(2)} placeholder="$ warn" className={`${inputClass} w-20 py-1 text-xs`} aria-label={`${x.label} warning line`} />
                        {manual ? <input name="balance" defaultValue={x.balanceCents === null ? "" : (x.balanceCents / 100).toFixed(2)} placeholder="$ balance" className={`${inputClass} w-24 py-1 text-xs`} aria-label={`${x.label} balance`} title="No balance API: type the balance from their portal" /> : null}
                        <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                          Save
                        </Button>
                      </form>
                    </Td>
                  </tr>
                );
              })}
            </Table>
            <p className="mt-2 text-xs text-zinc-500">Only Telnyx publishes a balance. For prepaid credit elsewhere (jambonz, Anthropic, Cartesia) type the balance from their portal; it shows when it was entered. A balance at or under its line turns red and shows a warning on every Platform tab. Anthropic&rsquo;s month figure needs <code>ANTHROPIC_ADMIN_KEY</code> on the engine (it reads the Admin API cost report).</p>
          </Card>
        </>
      ) : null}

      {tab === "clients" ? (
        <>
      <Card title={`Clients: balances and payments (${o.period})`}>
        <Table head={["Client", "Seats", "Balance", "Revenue", "Cost", "Margin", "Record payment", ""]}>
          {o.tenants.map((t) => (
            <tr key={t.id}>
              <Td>
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-zinc-500">
                  {t.users} people{t.suspended ? " · " : ""}
                  {t.suspended ? <Badge tone="red">outbound paused</Badge> : null}
                </div>
              </Td>
              <Td className="tabular-nums">{t.seats}</Td>
              <Td className={`tabular-nums ${t.balanceCents <= 0 ? "text-red-300" : t.balanceCents <= t.lowBalanceCents ? "text-amber-300" : ""}`}>{cents(t.balanceCents)}</Td>
              <Td className="tabular-nums">{cents(t.revenueCents)}</Td>
              <Td className="tabular-nums text-zinc-400">{cents(t.costCents)}</Td>
              <Td className={`tabular-nums ${t.marginCents < 0 ? "text-red-300" : "text-emerald-300"}`}>{cents(t.marginCents)}</Td>
              <Td>
                <form action={recordPayment} className="flex items-center gap-1">
                  <input type="hidden" name="tenantId" value={t.id} />
                  <input name="amount" placeholder="$ amount" className={`${inputClass} w-24 py-1 text-xs`} required />
                  <input name="note" placeholder="wire, check #…" className={`${inputClass} w-32 py-1 text-xs`} />
                  <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                    Apply
                  </Button>
                </form>
              </Td>
              <Td>
                <form action={openWorkspace}>
                  <input type="hidden" name="tenantId" value={t.id} />
                  <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                    Open
                  </Button>
                </form>
              </Td>
            </tr>
          ))}
          {o.tenants.length === 0 ? (
            <tr>
              <Td className="text-zinc-500">No client workspaces yet. Create one below.</Td>
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Td key={i}>{""}</Td>
              ))}
            </tr>
          ) : null}
        </Table>
        <p className="mt-2 text-xs text-zinc-500">A negative amount is an adjustment (credit back or correction). Payments lift a pause immediately. &ldquo;Open&rdquo; steps you into that client&rsquo;s workspace as its admin until you come back.</p>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card title="New client workspace">
          <form action={createWorkspace} className="space-y-3 text-sm">
            <Field label="Business name">
              <input name="name" className={inputClass} placeholder="National Solar Resolutions" required />
            </Field>
            <Field label="Their admin's email (optional)" hint="They sign in with it and land in their own workspace as admin. Leave blank to run it yourself from here.">
              <input name="adminEmail" type="email" className={inputClass} />
            </Field>
            <Button type="submit">Create workspace</Button>
            <p className="text-xs text-zinc-500">A new workspace starts empty with a billing account on the default plan and a zero balance. Open it to set up people, numbers and campaigns, or move a campaign into it below.</p>
          </form>
        </Card>

        <Card title={`Move a campaign out of ${s.tenant.name}`}>
          {campaigns.length === 0 ? (
            <p className="text-sm text-zinc-500">No campaigns in this workspace to move.</p>
          ) : (
            <form action={moveCampaignToWorkspace} className="space-y-3 text-sm">
              <Field label="Campaign">
                <select name="campaignId" className={inputClass}>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To workspace">
                <select name="toTenantId" className={inputClass}>
                  {o.tenants
                    .filter((t) => t.id !== s.tenant.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  {s.actingFrom ? <option value={platformTenantId}>{s.actingFrom.name} (platform)</option> : null}
                </select>
              </Field>
              <Button type="submit" variant="danger">
                Move campaign
              </Button>
              <p className="text-xs text-zinc-500">Takes the campaign with its lists, leads and history, calls, texts, callbacks, dispositions, dial plans, scripts, webhooks, the numbers pinned to it, and the agents who work only this campaign. Cadence profiles and audio it uses are copied; the system do-not-call list is copied. One transaction: all or nothing.</p>
            </form>
          )}
        </Card>
      </div>
        </>
      ) : null}

      {tab === "costs" ? (
        <>
          <Card title="Fixed monthly costs (vendors with no usable API)">
            <Table head={["Vendor", "What", "Client", "Amount", "Months", ""]}>
              {a.fixedCosts.map((c) => (
                <tr key={c.id}>
                  <Td className="capitalize">{c.vendor}</Td>
                  <Td>
                    <div>{c.label}</div>
                    <div className="text-xs text-zinc-500">{VENDOR_KIND[c.kind] ?? c.kind}{c.note ? ` · ${c.note}` : ""}</div>
                  </Td>
                  <Td>{c.tenantName ?? <span className="text-zinc-500">shared</span>}</Td>
                  <Td className={`tabular-nums ${c.amountCents === 0 ? "text-amber-300" : ""}`}>{c.amountCents === 0 ? "not entered" : cents(c.amountCents)}</Td>
                  <Td className="text-xs text-zinc-400">{c.cadence === "ONCE" ? `once, ${c.startPeriod}` : `monthly from ${c.startPeriod}${c.endPeriod ? ` to ${c.endPeriod}` : ""}`}</Td>
                  <Td>
                    <details>
                      <summary className="cursor-pointer text-xs text-sky-400">Edit</summary>
                      <FixedCostForm c={c} tenants={a.tenants} />
                      <form action={deleteFixedCost} className="mt-2">
                        <input type="hidden" name="id" value={c.id} />
                        <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                          Delete
                        </Button>
                      </form>
                    </details>
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="mt-4 rounded-md border border-zinc-800 p-3">
              <div className="mb-2 text-sm font-medium">Add a cost</div>
              <FixedCostForm c={null} tenants={a.tenants} defaultPeriod={a.period} />
            </div>
            <p className="mt-2 text-xs text-zinc-500">Railway (web, engine, Postgres, Redis), Clerk, the jambonz.cloud plan, a scrub subscription, Vercel if it serves Crossbar for us. Entered once; each month it covers is written into the costs (and changes when you edit it). With a client it is that client&rsquo;s cost (a 10DLC campaign fee, a number reputation fee); shared costs are spread by the rule below. If jambonz answers its invoice API and no jambonz cost is entered here, the invoice is used instead.</p>
          </Card>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
            <Card title="Allocation and margin floor">
              <form action={saveAccountingSettings} className="space-y-3 text-sm">
                <Field label="Spread shared costs across clients by" hint="Minutes: by billed talk minutes this month (the telephony plan and hosting scale with calls). Seats: by agent seats billed this month. A client with none carries none.">
                  <select name="costAllocation" defaultValue={a.settings.costAllocation} className={inputClass}>
                    <option value="MINUTES">Minutes</option>
                    <option value="SEATS">Seats</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="allocateUnattributed" defaultChecked={a.settings.allocateUnattributed} />
                  Also spread vendor usage that matched no client (AMD, conference legs, unmatched records)
                </label>
                <Field label="Margin floor, %" hint="A client under this margin shows red.">
                  <input name="marginFloorPct" defaultValue={a.settings.marginFloorPct} className={inputClass} />
                </Field>
                <Field label="Text to speech, ¢ per 1,000 characters" hint="Cartesia through jambonz: no usage API, so the characters each spoken prompt sends are counted and priced here. 4¢ ≈ Cartesia's per-character list price; set 0 if a flat plan is entered above instead. jambonz caches repeated prompts, so this errs high.">
                  <input name="ttsCost" defaultValue={toMilli(a.settings.ttsCostMillicentsPerKChar)} className={inputClass} />
                </Field>
                <Button type="submit" variant="ghost">
                  Save
                </Button>
              </form>
            </Card>
        <Card title="Cost rates (until a vendor record is matched, and for vendors with no API)">
          <form action={saveRates} className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Telnyx outbound, ¢ per minute">
                <input name="outPerMin" defaultValue={toMilli(o.rates.telnyxOutMillicentsPerMin)} className={inputClass} />
              </Field>
              <Field label="Telnyx inbound, ¢ per minute">
                <input name="inPerMin" defaultValue={toMilli(o.rates.telnyxInMillicentsPerMin)} className={inputClass} />
              </Field>
              <Field label="Number, $ per month">
                <input name="didMonthly" defaultValue={(o.rates.didMonthlyCents / 100).toFixed(2)} className={inputClass} />
              </Field>
              <Field label="Scrub, ¢ per record">
                <input name="scrubCost" defaultValue={toMilli(o.rates.scrubCostMillicents)} className={inputClass} />
              </Field>
              <Field label="Text, ¢ per segment">
                <input name="smsCost" defaultValue={toMilli(o.rates.smsCostMillicents)} className={inputClass} />
              </Field>
              <Field label="AI answer speech, ¢ per minute" hint="jambonz speech-to-text + text-to-speech per AI minute, from their invoices. The LLM is costed from tokens.">
                <input name="aiMinuteCost" defaultValue={toMilli(o.rates.aiMinuteCostMillicents ?? 0)} className={inputClass} />
              </Field>
              <Field label="Live transcription, ¢ per leg-minute" hint="Speech-to-text for live transcription (each side of a call is a leg), from the jambonz / STT vendor invoice. 0 until entered.">
                <input name="sttMinuteCost" defaultValue={toMilli(o.rates.sttMinuteCostMillicents ?? 0)} className={inputClass} />
              </Field>
            </div>
            <Field label="Prepayment instructions shown to clients" hint="Bank wire details, who to email the remittance to, and so on.">
              <textarea name="prepayInstructions" rows={4} defaultValue={o.rates.prepayInstructions ?? ""} className={inputClass} />
            </Field>
            <Button type="submit" variant="ghost">
              Save cost rates
            </Button>
            <p className="text-xs text-zinc-500">Telnyx list prices (Nov 2026): outbound US from 0.5¢/min, inbound from 0.32¢/min, local number $1.00/month plus $0.10 with texting.</p>
          </form>
        </Card>
          </div>
        </>
      ) : null}

      {tab === "plans" ? (
        <Card title="Rate plan per client">
          <div className="space-y-4">
            {o.tenants.map((t) => {
              const p = t.plan ?? { seatMonthlyCents: 7000, perMinuteMillicents: 1200, didMarkupPct: 50, scrubMarginMillicents: 500, smsPriceMillicents: 1500, aiMinutePriceMillicents: 0, transcriptMinutePriceMillicents: 0, assistCallPriceMillicents: 0, lowBalanceCents: 20000, graceDays: 3 };
              return (
                <form key={t.id} action={savePlan} className="rounded-md border border-zinc-800 p-3 text-sm">
                  <input type="hidden" name="tenantId" value={t.id} />
                  <div className="mb-2 font-medium">{t.name}</div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Field label="Seat $/mo">
                      <input name="seat" defaultValue={(p.seatMonthlyCents / 100).toFixed(2)} className={inputClass} />
                    </Field>
                    <Field label="¢ / minute">
                      <input name="perMinute" defaultValue={toMilli(p.perMinuteMillicents)} className={inputClass} />
                    </Field>
                    <Field label="Number markup %">
                      <input name="didMarkup" defaultValue={p.didMarkupPct} className={inputClass} />
                    </Field>
                    <Field label="Scrub margin ¢/rec">
                      <input name="scrubMargin" defaultValue={toMilli(p.scrubMarginMillicents)} className={inputClass} />
                    </Field>
                    <Field label="Text ¢/segment">
                      <input name="smsPrice" defaultValue={toMilli(p.smsPriceMillicents)} className={inputClass} />
                    </Field>
                    <Field label="AI answer ¢/minute" hint="0 = not charged">
                      <input name="aiMinutePrice" defaultValue={toMilli(p.aiMinutePriceMillicents ?? 0)} className={inputClass} />
                    </Field>
                    <Field label="Transcription ¢/minute" hint="Per transcribed call minute; 0 = not charged">
                      <input name="transcriptMinutePrice" defaultValue={toMilli(p.transcriptMinutePriceMillicents ?? 0)} className={inputClass} />
                    </Field>
                    <Field label="Live assist ¢/suggestion" hint="Per AI line suggested; 0 = not charged">
                      <input name="assistCallPrice" defaultValue={toMilli(p.assistCallPriceMillicents ?? 0)} className={inputClass} />
                    </Field>
                    <Field label="Warn below $">
                      <input name="lowBalance" defaultValue={(p.lowBalanceCents / 100).toFixed(2)} className={inputClass} />
                    </Field>
                    <Field label="Grace days at $0">
                      <input name="graceDays" defaultValue={p.graceDays} className={inputClass} />
                    </Field>
                  </div>
                  <Button type="submit" variant="ghost" className="mt-2">
                    Save plan
                  </Button>
                </form>
              );
            })}
            {o.tenants.length === 0 ? <p className="text-sm text-zinc-500">Plans appear per client once there are client workspaces. Defaults: $70 per seat, 1.2¢ per minute, numbers at cost + 50%, scrub at cost + 0.5¢ per record, warn below $200, 3 days of grace at zero.</p> : null}
          </div>
        </Card>
      ) : null}

      {tab === "referrals" ? <ReferralsCard r={refs} /> : null}
    </div>
  );
}

function FixedCostForm({ c, tenants, defaultPeriod }: { c: { id: string; tenantId: string | null; vendor: string; kind: string; label: string; amountCents: number; cadence: string; startPeriod: string; endPeriod: string | null; note: string | null } | null; tenants: { id: string; name: string }[]; defaultPeriod?: string }) {
  return (
    <form action={saveFixedCost} className="mt-2 grid gap-2 text-sm md:grid-cols-4">
      {c ? <input type="hidden" name="id" value={c.id} /> : null}
      <Field label="Vendor">
        <input name="vendor" defaultValue={c?.vendor ?? ""} placeholder="railway" className={inputClass} required />
      </Field>
      <Field label="What">
        <input name="label" defaultValue={c?.label ?? ""} placeholder="Railway: web, engine, Postgres, Redis" className={inputClass} required />
      </Field>
      <Field label="Kind">
        <select name="kind" defaultValue={c?.kind ?? "subscription"} className={inputClass}>
          {["subscription", "hosting", "auth", "10dlc", "scrub", "number", "other"].map((k) => (
            <option key={k} value={k}>
              {VENDOR_KIND[k] ?? k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount, $">
        <input name="amount" defaultValue={c ? (c.amountCents / 100).toFixed(2) : ""} className={inputClass} required />
      </Field>
      <Field label="Client">
        <select name="tenantId" defaultValue={c?.tenantId ?? ""} className={inputClass}>
          <option value="">Shared (spread across clients)</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="How often">
        <select name="cadence" defaultValue={c?.cadence ?? "MONTHLY"} className={inputClass}>
          <option value="MONTHLY">Every month</option>
          <option value="ONCE">Once</option>
        </select>
      </Field>
      <Field label="From month">
        <input name="startPeriod" type="month" defaultValue={c?.startPeriod ?? defaultPeriod} className={inputClass} required />
      </Field>
      <Field label="To month (optional)">
        <input name="endPeriod" type="month" defaultValue={c?.endPeriod ?? ""} className={inputClass} />
      </Field>
      <div className="md:col-span-3">
        <Field label="Note">
          <input name="note" defaultValue={c?.note ?? ""} placeholder="From the October invoice" className={inputClass} />
        </Field>
      </div>
      <div className="flex items-end">
        <Button type="submit" variant="ghost">
          {c ? "Save" : "Add cost"}
        </Button>
      </div>
    </form>
  );
}
