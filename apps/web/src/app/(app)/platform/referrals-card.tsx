// /platform → Referrals (owner, 6 Nov): commission rate, trial settings, every
// relationship, per-referrer overrides, attribution before the lock, ending a
// relationship, and the idempotent month run.
import Link from "next/link";
import { money } from "@/components/billing-badge";
import { Badge, Button, Card, Field, Table, Td, inputClass } from "@/components/ui";
import { changeAttribution, endReferral, runReferralCredits, saveReferralSettings, setReferrerOverride, type PlatformReferrals } from "@/lib/referral-actions";

const TONE: Record<string, "green" | "amber" | "zinc" | "blue"> = { active: "green", inactive: "amber", trial: "blue", ended: "zinc", new: "zinc" };
const monthName = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function ReferralsCard({ r }: { r: PlatformReferrals }) {
  const st = r.settings;
  const referrerIds = new Set(r.relationships.map((x) => x.referrerId));
  const referrers = r.tenants.filter((t) => referrerIds.has(t.id) || t.code || t.pctOverride !== null);
  return (
    <div id="referrals" className="mt-6 scroll-mt-24">
      <Card title="Referrals and free trial">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <form action={saveReferralSettings} className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Commission %" hint="Of a referred client's paid usage, monthly">
                <input name="referralPct" defaultValue={st.referralPct} className={inputClass} />
              </Field>
              <Field label="Trial days">
                <input name="trialDays" defaultValue={st.trialDays} className={inputClass} />
              </Field>
              <Field label="Trial seats">
                <input name="trialSeats" defaultValue={st.trialSeats} className={inputClass} />
              </Field>
              <Field label="Trial allowance $">
                <input name="trialAllowance" defaultValue={(st.trialAllowanceCents / 100).toFixed(2)} className={inputClass} />
              </Field>
              <Field label="Trial max numbers">
                <input name="trialMaxNumbers" defaultValue={st.trialMaxNumbers} className={inputClass} />
              </Field>
            </div>
            <label className="flex items-start gap-2 text-zinc-300">
              <input type="checkbox" name="trialWithoutReferral" defaultChecked={st.trialWithoutReferral} className="mt-1" />
              <span>Offer the trial to sign-ups that did not come through a referral link</span>
            </label>
            <Button type="submit" variant="ghost">
              Save referral and trial settings
            </Button>
            <p className="text-xs text-zinc-500">
              Trial settings apply to new sign-ups. A rate change applies from the next month run; the Referral Terms promise 30 days&rsquo; notice, so announce it first. Terms:{" "}
              <Link href="/legal/referral-terms" className="underline">
                referral
              </Link>
              ,{" "}
              <Link href="/legal/trial-terms" className="underline">
                trial
              </Link>
              .
            </p>
          </form>
          <div className="space-y-3 text-sm">
            <form action={runReferralCredits} className="flex flex-wrap items-end gap-2">
              <Field label="Month">
                <input type="month" name="period" defaultValue={r.lastPeriod} className={`${inputClass} w-44`} />
              </Field>
              <Button type="submit">Run referral credits for {monthName(r.lastPeriod)}</Button>
            </form>
            <p className="text-xs text-zinc-500">
              Runs by itself on the 1st for the month before. Safe to press again: each relationship is credited once per month. {r.lastRun ? `${monthName(r.lastPeriod)} last run ${new Date(r.lastRun).toLocaleString()}.` : `${monthName(r.lastPeriod)} has not been run yet.`} Pick another month in the box to run it instead (the button names last month).
            </p>
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Per-referrer rate</div>
              {referrers.length === 0 ? <p className="text-xs text-zinc-500">No client has opened Refer &amp; earn yet.</p> : null}
              <div className="space-y-1.5">
                {referrers.map((t) => (
                  <form key={t.id} action={setReferrerOverride} className="flex items-center gap-2 text-xs">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <span className="min-w-0 flex-1 truncate">
                      {t.name} {t.code ? <span className="text-zinc-500">· {t.code}</span> : null} {t.termsAccepted ? null : <Badge tone="amber">terms not accepted</Badge>}
                    </span>
                    <input name="pct" defaultValue={t.pctOverride ?? ""} placeholder={`${st.referralPct}`} className={`${inputClass} w-20 py-1 text-xs`} />
                    <span className="text-zinc-500">%</span>
                    <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                      Set
                    </Button>
                  </form>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500">Blank = the platform rate.</p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <Table head={["Referrer", "Referred", "Since", "Status", `${r.lastPeriod} base`, "Credit", "Lifetime", "Attribution", "End"]}>
            {r.relationships.map((x) => (
              <tr key={x.id}>
                <Td className="font-medium">{x.referrer}</Td>
                <Td>{x.referred}</Td>
                <Td className="text-xs text-zinc-400">
                  {x.since.slice(0, 10)}
                  <div>{x.source === "platform" ? "set by platform" : "link"}</div>
                </Td>
                <Td>
                  <Badge tone={TONE[x.status] ?? "zinc"}>{x.status}</Badge>
                  {x.endedReason ? <div className="mt-1 text-xs text-zinc-500">{x.endedReason}</div> : x.lastReason ? <div className="mt-1 text-xs text-zinc-500">{x.lastReason}</div> : null}
                </Td>
                <Td className="tabular-nums">{x.lastBaseCents === null ? "—" : money(x.lastBaseCents)}</Td>
                <Td className="tabular-nums">{x.lastCreditCents === null ? "—" : money(x.lastCreditCents)}</Td>
                <Td className="tabular-nums">{money(x.lifetimeCents)}</Td>
                <Td>
                  {x.lockedAt || x.endedAt ? (
                    <span className="text-xs text-zinc-500">{x.endedAt ? "ended" : `locked ${x.lockedAt!.slice(0, 10)} (first payment)`}</span>
                  ) : (
                    <form action={changeAttribution} className="flex items-center gap-1">
                      <input type="hidden" name="referralId" value={x.id} />
                      <select name="referrerTenantId" defaultValue={x.referrerId} className={`${inputClass} w-36 py-1 text-xs`}>
                        {r.tenants
                          .filter((t) => t.id !== x.referredId)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                      <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">
                        Change
                      </Button>
                    </form>
                  )}
                </Td>
                <Td>
                  {x.endedAt ? (
                    <span className="text-xs text-zinc-500">{x.endedAt.slice(0, 10)}</span>
                  ) : (
                    <form action={endReferral} className="flex items-center gap-1">
                      <input type="hidden" name="referralId" value={x.id} />
                      <input name="reason" placeholder="reason" className={`${inputClass} w-28 py-1 text-xs`} />
                      <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                        End
                      </Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
            {r.relationships.length === 0 ? (
              <tr>
                <Td className="text-zinc-500">No referrals yet.</Td>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <Td key={i}>{""}</Td>
                ))}
              </tr>
            ) : null}
          </Table>
          <p className="mt-2 text-xs text-zinc-500">Ending is permanent: the relationship earns nothing from then on; credits already posted stay. Attribution locks at the referred client&rsquo;s first payment.</p>
        </div>

        <div className="mt-6">
          <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Trials</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {r.tenants.filter((t) => t.trial).length === 0 ? <span className="text-zinc-500">No client has had a trial yet.</span> : null}
            {r.tenants
              .filter((t) => t.trial)
              .map((t) => (
                <span key={t.id} className="rounded border border-zinc-800 px-2 py-1">
                  {t.name} · <Badge tone={t.trial === "trial" ? "blue" : t.trial === "converted" ? "green" : "zinc"}>{t.trial === "trial" ? "in trial" : t.trial === "converted" ? "paid" : "trial ended, unpaid"}</Badge>
                </span>
              ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
