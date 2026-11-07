import { TEN_DLC_CAMPAIGN_OK, USECASES, VERTICALS } from "@strowger/shared/tendlc";
import { readOnboarding } from "@strowger/shared/onboarding";
import { requireClientWorkspace } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { Badge, Button, Card, Field, PageHeader, inputClass } from "@/components/ui";
import { assignNumbersToTenDlc, registerBrand, registerCampaign } from "../actions";
import { Flash, provisionStatus, tenDlcTone, type TenDlc } from "../parts";

/**
 * Texting tab: 10DLC brand and campaign registration with The Campaign
 * Registry, and their status. Split out of /numbers on 7 Nov; the forms and
 * actions are unchanged.
 */
export default async function TextingPage({ searchParams }: PageProps<"/numbers/texting">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const [{ status, error: statusError }, ten] = await Promise.all([
    provisionStatus(s.tenant.id),
    engine<TenDlc>(`/provision/tendlc?tenantId=${s.tenant.id}`).then(
      (r) => ({ r, e: null }),
      (e: unknown) => ({ r: null, e: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const tenDlc: TenDlc | null = ten.r;
  // The setup wizard's Business answers prefill the brand form.
  const ob = readOnboarding(s.tenant.onboarding).steps.business ?? {};
  const brandStatus = (tenDlc?.brand?.status as string | undefined) ?? undefined;
  const brandIdentity = (tenDlc?.brand?.identityStatus as string | undefined) ?? undefined;
  const campStatus = (tenDlc?.campaign?.campaignStatus as string | undefined) ?? (tenDlc?.campaign?.status as string | undefined);
  const campOk = Boolean(campStatus && TEN_DLC_CAMPAIGN_OK.test(campStatus));

  return (
    <div>
      <PageHeader
        title="Texting registration (10DLC)"
        subtitle="US carriers require every business that texts from local numbers to register a brand and a campaign with The Campaign Registry; unregistered traffic is filtered or blocked. Telnyx submits both: brand verification is usually quick, carrier review of the campaign takes days."
      />
      <Flash sp={sp} engineError={statusError ?? ten.e} />
      <Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
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
                {String(tenDlc.brand?.displayName ?? "")} · {String(tenDlc.brand?.companyName ?? "")} · brand id <code className="break-all">{tenDlc.brandId}</code>
                {tenDlc.brand?.failureReasons ? <div className="mt-1 text-red-300">{String(tenDlc.brand.failureReasons)}</div> : null}
              </div>
            ) : (
              <form action={registerBrand} className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <p className="text-xs text-zinc-500 sm:col-span-2">Prefilled from the setup wizard&apos;s Business step where it has answers; checked against the same 10DLC rules before it is sent.</p>
                <Field label="Legal company name">
                  <input name="companyName" defaultValue={ob.legalName ?? ""} className={inputClass} required />
                </Field>
                <Field label="Brand / display name">
                  <input name="displayName" defaultValue={ob.dba || ob.legalName || s.tenant.name} className={inputClass} required />
                </Field>
                <Field label="Entity type">
                  <select name="entityType" className={inputClass} defaultValue={ob.entityType || "PRIVATE_PROFIT"}>
                    <option value="PRIVATE_PROFIT">Private company</option>
                    <option value="PUBLIC_PROFIT">Public company</option>
                    <option value="NON_PROFIT">Non-profit</option>
                    <option value="SOLE_PROPRIETOR">Sole proprietor</option>
                    <option value="GOVERNMENT">Government</option>
                  </select>
                </Field>
                <Field label="EIN (tax id)">
                  <input name="ein" defaultValue={ob.ein ?? ""} className={inputClass} placeholder="12-3456789" />
                </Field>
                <Field label="Industry (vertical)">
                  <select name="vertical" className={inputClass} defaultValue={ob.vertical || "INSURANCE"}>
                    {VERTICALS.map((v) => (
                      <option key={v} value={v}>
                        {v.replace("_", " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Website">
                  <input name="website" defaultValue={ob.website ?? ""} className={inputClass} placeholder="https://" />
                </Field>
                <Field label="Contact email">
                  <input name="email" type="email" defaultValue={ob.supportEmail || s.user.email} className={inputClass} required />
                </Field>
                <Field label="Contact phone">
                  <input name="phone" defaultValue={ob.phone ?? ""} className={inputClass} placeholder="+13055550100" />
                </Field>
                <Field label="Street">
                  <input name="street" defaultValue={ob.street ?? ""} className={inputClass} />
                </Field>
                <Field label="City">
                  <input name="city" defaultValue={ob.city ?? ""} className={inputClass} />
                </Field>
                <Field label="State (2 letters)">
                  <input name="state" maxLength={2} defaultValue={ob.state ?? ""} className={inputClass} />
                </Field>
                <Field label="ZIP">
                  <input name="postalCode" defaultValue={ob.zip ?? ""} className={inputClass} />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!status?.telnyx}>
                    Register brand
                  </Button>
                </div>
              </form>
            )}
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold">
              Campaign {tenDlc?.campaignId ? <Badge tone={tenDlcTone(campStatus)}>{campStatus ?? "submitted"}</Badge> : <Badge tone="amber">not registered</Badge>}
            </h3>
            {tenDlc?.campaignId ? (
              <div className="space-y-2 text-sm text-zinc-300">
                <div>
                  Use case {String(tenDlc.campaign?.usecase ?? "")} · campaign id <code className="break-all">{tenDlc.campaignId}</code>
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
                  <input name="sample1" className={inputClass} required defaultValue={`Hi Jane, this is ${String(((s.tenant.tenDlcBrand ?? {}) as { displayName?: string }).displayName || s.tenant.name)}. Your phone is going to ring within the next 30 seconds from (305) 555-0100. If you miss us, call that number back when you're ready. Reply STOP if you'd rather not get a call.`} />
                </Field>
                <Field label="Sample message 2">
                  <input name="sample2" className={inputClass} defaultValue={`${String(((s.tenant.tenDlcBrand ?? {}) as { displayName?: string }).displayName || s.tenant.name)}: hey Jane, sorry I missed you! Call us back anytime, or tap the link to pick a quick callback time: https://strowger.crossbar.digital/cb/abc123 Reply STOP to opt out.`} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
    </div>
  );
}
