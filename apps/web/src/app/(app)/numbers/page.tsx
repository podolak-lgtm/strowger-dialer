import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import Link from "next/link";
import { requireClientWorkspace } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { Badge, Button, Card, Field, Notice, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { assignCampaign, assignNumbersToTenDlc, orderSelected, registerBrand, registerCampaign, releaseOne, runSetup, syncNow } from "./actions";

type Status = {
  telnyx: boolean;
  jambonz: boolean;
  sbcFqdn: string;
  smsWebhook: string;
  carrierName: string;
  connection: { id: string; name: string; fqdn: string | null } | null;
  outboundProfileId: string | null;
  messagingProfile: { id: string; name: string; webhook: string | null } | null;
  carrier: { sid: string; name: string; gateways: number } | null;
  counts: Record<string, number>;
  missing: string[];
};
type Found = { phone: string; e164: string; city: string | null; state: string | null; monthly: string | null; upfront: string | null; features: string[] };
type TenDlc = {
  brandId: string | null;
  campaignId: string | null;
  messagingProfileId: string | null;
  brand: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
  numbersAssigned: number | null;
};

const VERTICALS = ["INSURANCE", "FINANCIAL", "REAL_ESTATE", "LEGAL", "HEALTHCARE", "EDUCATION", "RETAIL", "PROFESSIONAL", "TECHNOLOGY", "ENERGY", "CONSTRUCTION", "HOSPITALITY", "COMMUNICATION", "AGRICULTURE", "ENTERTAINMENT", "HUMAN_RESOURCES", "MANUFACTURING", "NGO", "POLITICAL", "POSTAL", "TRANSPORTATION", "GAMBLING", "GOVERNMENT"];
const USECASES: [string, string][] = [
  ["LOW_VOLUME", "Low volume mixed (under 2,000 msgs/day; fastest approval)"],
  ["MIXED", "Mixed: marketing + customer care"],
  ["MARKETING", "Marketing / promotions"],
  ["CUSTOMER_CARE", "Customer care (support, account)"],
  ["ACCOUNT_NOTIFICATION", "Account notifications"],
  ["DELIVERY_NOTIFICATION", "Delivery notifications"],
  ["2FA", "Two-factor authentication"],
  ["POLLING_VOTING", "Polling / voting"],
  ["PUBLIC_SERVICE_ANNOUNCEMENT", "Public service announcement"],
];

function statusTone(s: string): "zinc" | "green" | "amber" | "red" | "blue" {
  if (s === "ready") return "green";
  if (s === "voice") return "blue";
  if (s === "ordered") return "amber";
  if (s === "failed") return "red";
  return "zinc";
}
function tenDlcTone(s: string | undefined): "zinc" | "green" | "amber" | "red" {
  if (!s) return "zinc";
  if (/PROVISIONED|ACCEPTED|VERIFIED|^OK$/.test(s)) return "green";
  if (/FAIL|REJECT|SUSPEND|EXPIRED/.test(s)) return "red";
  return "amber";
}

export default async function NumbersPage({ searchParams }: PageProps<"/numbers">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const msg = str("msg");
  const kind = str("kind") === "error" ? "error" : "ok";
  const campaignPick = str("campaign");
  const areaCode = str("areaCode").replace(/\D/g, "").slice(0, 3);
  const qty = Math.min(50, Math.max(1, Number(str("qty")) || 10));

  const [campaigns, numbers, orders] = await Promise.all([
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id, status: { not: "RETIRED" } }, orderBy: [{ createdAt: "desc" }], include: { campaign: { select: { name: true } } }, take: 300 }),
    prisma.numberOrder.findMany({ where: { tenantId: s.tenant.id }, orderBy: { createdAt: "desc" }, take: 20, include: { campaign: { select: { name: true } }, _count: { select: { numbers: true } } } }),
  ]);

  let status: Status | null = null;
  let statusError: string | null = null;
  let tenDlc: TenDlc | null = null;
  try {
    [status, tenDlc] = await Promise.all([engine<Status>(`/provision/status?tenantId=${s.tenant.id}`), engine<TenDlc>(`/provision/tendlc?tenantId=${s.tenant.id}`)]);
  } catch (e) {
    statusError = e instanceof Error ? e.message : String(e);
  }
  const setupDone = Boolean(status?.connection && status?.carrier && status?.messagingProfile);

  let found: Found[] = [];
  let searchError: string | null = null;
  if (areaCode.length === 3 && setupDone) {
    try {
      found = await engine<Found[]>("/provision/search", { method: "POST", body: JSON.stringify({ areaCode, limit: qty }) });
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }
  }

  const brandStatus = (tenDlc?.brand?.status as string | undefined) ?? undefined;
  const brandIdentity = (tenDlc?.brand?.identityStatus as string | undefined) ?? undefined;
  const campStatus = (tenDlc?.campaign?.campaignStatus as string | undefined) ?? (tenDlc?.campaign?.status as string | undefined);
  const campOk = Boolean(campStatus && /MNO_PROVISIONED|MNO_ACCEPTED|TELNYX_ACCEPTED|TCR_ACCEPTED/.test(campStatus));

  return (
    <div>
      <PageHeader
        title="Numbers & provisioning"
        subtitle="Buy local numbers, attach them to the voice trunk and texting profile, and register them in jambonz, all from here. Reputation, warm-up and daily caps live on the DIDs page."
        actions={
          <>
            <form action={syncNow}>
              <Button type="submit" variant="ghost">
                Sync with Telnyx
              </Button>
            </form>
            <Link href="/dids" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
              DIDs & reputation
            </Link>
          </>
        }
      />
      {msg ? <Notice kind={kind}>{msg}</Notice> : null}
      {statusError ? <Notice kind="error">The engine did not answer: {statusError}</Notice> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="1 · Carrier setup (once)">
          {status ? (
            <div className="space-y-3 text-sm">
              {status.missing.length ? (
                <Notice kind="warn">
                  Set first (Railway dashboard, never in chat): {status.missing.join(", ")}.
                </Notice>
              ) : null}
              <Row ok={Boolean(status.connection)} label="Telnyx voice connection">
                {status.connection ? (
                  <>
                    {status.connection.name} → inbound to <code>{status.connection.fqdn ?? status.sbcFqdn}</code>
                  </>
                ) : (
                  <>will point inbound calls at <code>{status.sbcFqdn || "(no SBC address)"}</code></>
                )}
              </Row>
              <Row ok={Boolean(status.carrier)} label={`jambonz carrier "${status.carrierName}"`}>
                {status.carrier ? `${status.carrier.gateways} gateways (sip.telnyx.com outbound; Telnyx signalling IPs inbound)` : "outbound via sip.telnyx.com with the connection's credentials"}
              </Row>
              <Row ok={Boolean(status.messagingProfile)} label="Telnyx messaging profile">
                {status.messagingProfile ? (
                  <>
                    {status.messagingProfile.name} · webhook <code className="break-all">{status.messagingProfile.webhook ?? "none"}</code>
                  </>
                ) : (
                  <>
                    webhook <code className="break-all">{status.smsWebhook}</code>
                  </>
                )}
              </Row>
              <form action={runSetup} className="pt-2">
                <Button type="submit" disabled={status.missing.length > 0}>
                  {setupDone ? "Re-check setup" : "Run carrier setup"}
                </Button>
                <span className="ml-3 text-xs text-zinc-500">Idempotent: creates what is missing, reuses what exists by name.</span>
              </form>
              <p className="text-xs text-zinc-500">
                If the SBC address shown is wrong for your jambonz account, set <code>JAMBONZ_SBC_FQDN</code> on the engine to the address the jambonz portal shows under Carriers and run setup again.
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Waiting for the engine…</p>
          )}
        </Card>

        <Card title="2 · Order numbers">
          {!setupDone ? <Notice kind="warn">Run carrier setup first; ordered numbers need the connection and profile to attach to.</Notice> : null}
          <form method="GET" className="grid grid-cols-[1fr_1fr_2fr_auto] items-end gap-3">
            <Field label="Area code">
              <input name="areaCode" defaultValue={areaCode} maxLength={3} pattern="\d{3}" className={inputClass} placeholder="305" required />
            </Field>
            <Field label="How many">
              <input name="qty" type="number" min={1} max={50} defaultValue={qty} className={inputClass} />
            </Field>
            <Field label="For campaign">
              <select name="campaign" defaultValue={campaignPick} className={inputClass}>
                <option value="">Shared pool (any campaign)</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="ghost" disabled={!setupDone}>
              Search
            </Button>
          </form>
          {searchError ? <Notice kind="error">{searchError}</Notice> : null}
          {found.length > 0 ? (
            <form action={orderSelected} className="mt-4">
              <input type="hidden" name="campaignId" value={campaignPick} />
              <input type="hidden" name="areaCode" value={areaCode} />
              <Table head={["", "Number", "Rate center", "State", "Monthly", "Features"]}>
                {found.map((n) => (
                  <tr key={n.e164}>
                    <Td>
                      <input type="checkbox" name="phones" value={n.phone} defaultChecked className="h-4 w-4" />
                    </Td>
                    <Td className="font-mono">{formatPhone(n.phone)}</Td>
                    <Td>{n.city ?? "–"}</Td>
                    <Td>{n.state ?? "–"}</Td>
                    <Td>{n.monthly ? `$${n.monthly}` : "–"}</Td>
                    <Td className="text-xs text-zinc-400">{n.features.join(", ")}</Td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3 flex items-center gap-3">
                <Button type="submit" className="bg-emerald-400 text-emerald-950 hover:bg-emerald-300">
                  Buy the checked numbers
                </Button>
                <span className="text-xs text-zinc-500">
                  Each is attached to the voice connection and the texting profile, registered in jambonz to the Strowger application, and added to the pool{campaignPick ? " for the chosen campaign" : ""}. New numbers
                  start unregistered at the Free Caller Registry and will not dial until marked registered on the DIDs page.
                </span>
              </div>
            </form>
          ) : areaCode.length === 3 && !searchError && setupDone ? (
            <p className="mt-3 text-sm text-zinc-500">Nothing available in {areaCode} right now with voice and SMS. Try a neighbouring area code.</p>
          ) : null}
        </Card>
      </div>

      <Card title="3 · Texting registration (10DLC)" className="mt-6">
        <p className="mb-4 text-sm text-zinc-400">
          US carriers require every business that texts from local numbers to register a brand and a campaign with The Campaign Registry. Unregistered traffic is filtered or blocked. Telnyx submits both;
          brand verification is usually quick, campaign review by the carriers takes days.
        </p>
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Brand{" "}
              {tenDlc?.brandId ? (
                <>
                  <Badge tone={tenDlcTone(brandStatus)}>{brandStatus ?? "submitted"}</Badge> <Badge tone={tenDlcTone(brandIdentity)}>{brandIdentity ?? "identity pending"}</Badge>
                </>
              ) : (
                <Badge tone="amber">not registered</Badge>
              )}
            </h3>
            {tenDlc?.brandId ? (
              <div className="text-sm text-zinc-300">
                {String(tenDlc.brand?.displayName ?? "")} · {String(tenDlc.brand?.companyName ?? "")} · brand id <code>{tenDlc.brandId}</code>
                {tenDlc.brand?.failureReasons ? <div className="mt-1 text-red-300">{String(tenDlc.brand.failureReasons)}</div> : null}
              </div>
            ) : (
              <form action={registerBrand} className="grid grid-cols-2 gap-3 text-sm">
                <Field label="Legal company name">
                  <input name="companyName" className={inputClass} required />
                </Field>
                <Field label="Brand / display name">
                  <input name="displayName" defaultValue={s.tenant.name} className={inputClass} required />
                </Field>
                <Field label="Entity type">
                  <select name="entityType" className={inputClass} defaultValue="PRIVATE_PROFIT">
                    <option value="PRIVATE_PROFIT">Private company</option>
                    <option value="PUBLIC_PROFIT">Public company</option>
                    <option value="NON_PROFIT">Non-profit</option>
                    <option value="SOLE_PROPRIETOR">Sole proprietor</option>
                    <option value="GOVERNMENT">Government</option>
                  </select>
                </Field>
                <Field label="EIN (tax id)">
                  <input name="ein" className={inputClass} placeholder="12-3456789" />
                </Field>
                <Field label="Industry (vertical)">
                  <select name="vertical" className={inputClass} defaultValue="INSURANCE">
                    {VERTICALS.map((v) => (
                      <option key={v} value={v}>
                        {v.replace("_", " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Website">
                  <input name="website" className={inputClass} placeholder="https://" />
                </Field>
                <Field label="Contact email">
                  <input name="email" type="email" defaultValue={s.user.email} className={inputClass} required />
                </Field>
                <Field label="Contact phone">
                  <input name="phone" className={inputClass} placeholder="+13055550100" />
                </Field>
                <Field label="Street">
                  <input name="street" className={inputClass} />
                </Field>
                <Field label="City">
                  <input name="city" className={inputClass} />
                </Field>
                <Field label="State (2 letters)">
                  <input name="state" maxLength={2} className={inputClass} />
                </Field>
                <Field label="ZIP">
                  <input name="postalCode" className={inputClass} />
                </Field>
                <div className="col-span-2">
                  <Button type="submit" disabled={!status?.telnyx}>
                    Register brand
                  </Button>
                </div>
              </form>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Campaign {tenDlc?.campaignId ? <Badge tone={tenDlcTone(campStatus)}>{campStatus ?? "submitted"}</Badge> : <Badge tone="amber">not registered</Badge>}
            </h3>
            {tenDlc?.campaignId ? (
              <div className="space-y-2 text-sm text-zinc-300">
                <div>
                  Use case {String(tenDlc.campaign?.usecase ?? "")} · campaign id <code>{tenDlc.campaignId}</code>
                  {typeof tenDlc.numbersAssigned === "number" ? ` · ${tenDlc.numbersAssigned} numbers assigned` : ""}
                </div>
                {tenDlc.campaign?.failureReasons ? <div className="text-red-300">{String(tenDlc.campaign.failureReasons)}</div> : null}
                <form action={assignNumbersToTenDlc}>
                  <Button type="submit" variant="ghost" disabled={!campOk}>
                    Assign all numbers on the texting profile to this campaign
                  </Button>
                  {!campOk ? <span className="ml-2 text-xs text-zinc-500">available once the carriers accept the campaign</span> : null}
                </form>
              </div>
            ) : !tenDlc?.brandId ? (
              <p className="text-sm text-zinc-500">Register the brand first.</p>
            ) : (
              <form action={registerCampaign} className="space-y-3 text-sm">
                <Field label="Use case">
                  <select name="usecase" className={inputClass} defaultValue="LOW_VOLUME">
                    {USECASES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Description (what the texts are for)">
                  <textarea name="description" rows={2} className={inputClass} required defaultValue={`${s.tenant.name} texts people who requested a quote or a callback on our website: a heads-up before we call, a note if we missed them with a link to pick a time, and replies from our agents.`} />
                </Field>
                <Field label="Message flow (how people opt in)" hint="Carriers check this against your website's form and privacy policy.">
                  <textarea name="messageFlow" rows={2} className={inputClass} required defaultValue="Consumers opt in by submitting a web form that states they agree to receive calls and texts from us about their request; the form carries the consent language and a link to our privacy policy. They can reply STOP at any time." />
                </Field>
                <Field label="Sample message 1">
                  <input name="sample1" className={inputClass} required defaultValue={`Hi Jane, this is ${s.tenant.name}. Your phone is going to ring within the next 30 seconds from (305) 555-0100. If you miss us, call that number back when you're ready. Reply STOP if you'd rather not get a call.`} />
                </Field>
                <Field label="Sample message 2">
                  <input name="sample2" className={inputClass} defaultValue={`Hey Jane, sorry I missed you! Call us back anytime, or tap the link to pick a quick callback time: https://strowger.crossbar.digital/cb/abc123 Reply STOP to opt out.`} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Privacy policy link">
                    <input name="privacyPolicyLink" className={inputClass} placeholder="https://…/privacy" />
                  </Field>
                  <Field label="Terms link">
                    <input name="termsAndConditionsLink" className={inputClass} placeholder="https://…/terms" />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-4 text-zinc-300">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="embeddedLink" defaultChecked className="h-4 w-4" /> Messages contain links
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="embeddedPhone" defaultChecked className="h-4 w-4" /> Messages contain phone numbers
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="numberPool" className="h-4 w-4" /> More than 49 numbers (number pool)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="directLending" className="h-4 w-4" /> Lending / loans
                  </label>
                </div>
                <Button type="submit">Submit campaign</Button>
              </form>
            )}
          </div>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title={`Numbers (${numbers.length})`}>
          {numbers.length === 0 ? (
            <p className="text-sm text-zinc-500">No numbers yet. Order some above, or Sync to adopt numbers already on the Telnyx account.</p>
          ) : (
            <Table head={["Number", "Campaign", "Provisioning", "Telnyx", "jambonz", "Added", ""]}>
              {numbers.map((n) => (
                <tr key={n.id}>
                  <Td className="font-mono">{formatPhone(n.phone)}</Td>
                  <Td>
                    <form action={assignCampaign} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={n.id} />
                      <select name="campaignId" defaultValue={n.campaignId ?? ""} className={`${inputClass} py-1 text-xs`}>
                        <option value="">Shared pool</option>
                        {campaigns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                        Save
                      </Button>
                    </form>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(n.provisionStatus)}>{n.provisionStatus}</Badge>
                    {n.provisionError ? <div className="mt-1 max-w-xs text-xs text-red-300">{n.provisionError}</div> : null}
                  </Td>
                  <Td className="text-xs text-zinc-400">{n.telnyxNumberId ? (n.smsEnabled ? "voice + SMS" : "voice") : "–"}</Td>
                  <Td className="text-xs text-zinc-400">{n.jambonzPhoneNumberSid ? "registered" : "–"}</Td>
                  <Td className="text-xs text-zinc-400">{n.createdAt.toLocaleDateString()}</Td>
                  <Td>
                    {n.telnyxNumberId ? (
                      <form action={releaseOne}>
                        <input type="hidden" name="id" value={n.id} />
                        <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                          Release
                        </Button>
                      </form>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Orders">
          {orders.length === 0 ? (
            <p className="text-sm text-zinc-500">No orders yet.</p>
          ) : (
            <div className="space-y-2 text-sm">
              {orders.map((o) => (
                <div key={o.id} className="rounded-md border border-zinc-800 p-3">
                  <div className="flex items-center justify-between">
                    <span>
                      {o.quantity} × {o.areaCode} {o.campaign ? `· ${o.campaign.name}` : "· shared pool"}
                    </span>
                    <Badge tone={o.status === "success" ? "green" : o.status === "pending" ? "amber" : "red"}>{o.status}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {o.createdAt.toLocaleString()} · {o._count.numbers} numbers · {o.requestedBy ?? ""}
                  </div>
                  {o.error ? <div className="mt-1 text-xs text-red-300">{o.error}</div> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ ok, label, children }: { ok: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${ok ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>{ok ? "✓" : "·"}</span>
      <div>
        <div className="font-medium text-zinc-200">{label}</div>
        <div className="text-xs text-zinc-400">{children}</div>
      </div>
    </div>
  );
}
