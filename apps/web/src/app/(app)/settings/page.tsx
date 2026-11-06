import { prisma } from "@strowger/db";
import Link from "next/link";
import { formatPhone } from "@strowger/shared";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { fcrPrefill } from "@/lib/onboarding";
import { addAudioAsset, addCallerIds, deleteAudioAsset, saveFcrProfile, saveGames, saveGoals, saveLevelRights, saveTexting, setCallerIdStatus, turnOffTestPhones, turnOnTestPhones, setCampaignAudio, uploadAudio } from "./actions";
import { AGENT_RIGHTS, LEVELS, rightsForLevel } from "@strowger/shared/games";
import { storageConfigured } from "@/lib/storage";
import { DEFAULT_TEST_PHONES, readTestPhones, testPhonesOn, TEST_PHONES_HOURS } from "@strowger/shared/compliance";
import { TestPhonesUntil } from "./test-phones-until";
import { runRecordingExportNow, saveRecordingPolicy } from "./recording-actions";

const KINDS = ["SAFE_HARBOR", "VOICEMAIL_DROP", "SCREENER_MESSAGE", "DISCLOSURE", "HOLD", "OTHER"] as const;

export default async function SettingsPage() {
  const s = await requireRole("SUPERVISOR");
  const [audio, callerIds, campaigns] = await Promise.all([
    prisma.audioAsset.findMany({ where: { tenantId: s.tenant.id }, orderBy: { createdAt: "desc" } }),
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id }, orderBy: [{ status: "asc" }, { areaCode: "asc" }] }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" } }),
  ]);
  const byKind = (k: string) => audio.filter((a) => a.kind === k || a.kind === "OTHER");
  const exp = (s.tenant.recordingExport ?? null) as { type?: string; host?: string; port?: number; username?: string; path?: string } | null;
  const [exportedCount, pendingExport] = await Promise.all([
    prisma.call.count({ where: { tenantId: s.tenant.id, recordingExportedTo: { not: null } } }),
    prisma.call.count({ where: { tenantId: s.tenant.id, recordingExportedTo: null, recordingDeletedAt: null, bridgedAt: { not: null }, endedAt: { not: null } } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={`${s.tenant.name} · workspace ${s.tenant.slug}`}
        actions={
          s.roles.includes("ADMIN") && !(s.tenant.isPlatform && !s.actingFrom) ? (
            <Link href="/welcome" className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
              Setup wizard
            </Link>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Audio files">
          <p className="mb-3 text-xs text-zinc-500">
            Prompts the dialer plays: safe-harbor on an abandoned call, voicemail drop, the screener answer, and the recording disclosure. Upload a WAV or MP3 (8 kHz mono
            WAV plays cleanest), or give a public https URL.
          </p>
          {storageConfigured ? (
            <form action={uploadAudio} className="mb-4 grid grid-cols-[1fr_160px_auto] items-end gap-2 rounded-md border border-zinc-800 p-3">
              <Field label="Name">
                <input name="name" required className={inputClass} placeholder="Voicemail drop - Solar" />
              </Field>
              <Field label="Kind">
                <select name="kind" className={inputClass}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k.replace("_", " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit">Upload</Button>
              <div className="col-span-3">
                <Field label="File (WAV or MP3)">
                  <input name="file" type="file" accept=".wav,.mp3,audio/*" required className="block text-sm text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-100" />
                </Field>
              </div>
            </form>
          ) : (
            <p className="mb-3 text-xs text-amber-300">Uploads need the media bucket (S3_* variables); URLs still work.</p>
          )}
          <form action={addAudioAsset} className="mb-4 grid grid-cols-[1fr_160px_auto] items-end gap-2">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Safe harbor - Acme" />
            </Field>
            <Field label="Kind">
              <select name="kind" className={inputClass}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit">Add</Button>
            <div className="col-span-3">
              <Field label="URL">
                <input name="url" required className={inputClass} placeholder="https://…/safe-harbor.wav" />
              </Field>
            </div>
          </form>
          {audio.length ? (
            <Table head={["Name", "Kind", "URL", ""]}>
              {audio.map((a) => (
                <tr key={a.id}>
                  <Td>{a.name}</Td>
                  <Td>
                    <Badge>{a.kind.replace("_", " ").toLowerCase()}</Badge>
                  </Td>
                  <Td className="max-w-xs truncate text-xs text-zinc-400">{a.storageUrl}</Td>
                  <Td>
                    <form action={deleteAudioAsset}>
                      <input type="hidden" name="id" value={a.id} />
                      <Button variant="danger" type="submit">
                        Remove
                      </Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>

        <Card title="Caller ID numbers">
          <p className="mb-3 text-xs text-zinc-500">
            Numbers you own at the carrier. Local presence picks the one matching the lead&apos;s area code. Rest or retire a number if it gets spam-labelled.
          </p>
          <form action={addCallerIds} className="mb-4 space-y-2">
            <Field label="Add numbers" hint="One per line or comma-separated.">
              <textarea name="numbers" rows={3} className={`${inputClass} font-mono`} placeholder={"(305) 555-0100\n(212) 555-0101"} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="smsEnabled" className="h-4 w-4" /> SMS-enabled (10DLC registered)
            </label>
            <Button type="submit">Add</Button>
          </form>
          {callerIds.length ? (
            <Table head={["Number", "Area", "State", "Used today", "Status", ""]}>
              {callerIds.map((n) => (
                <tr key={n.id}>
                  <Td className="font-mono text-xs">{formatPhone(n.phone)}</Td>
                  <Td>{n.areaCode}</Td>
                  <Td>{n.state ?? "—"}</Td>
                  <Td className="tabular-nums">{n.usedToday}</Td>
                  <Td>
                    <Badge tone={n.status === "ACTIVE" ? "green" : n.status === "SPAM_FLAGGED" ? "red" : "amber"}>{n.status.toLowerCase()}</Badge>
                  </Td>
                  <Td>
                    <form action={setCallerIdStatus} className="flex gap-1">
                      <input type="hidden" name="id" value={n.id} />
                      <select name="status" defaultValue={n.status} className={`${inputClass} w-36`}>
                        <option value="ACTIVE">Active</option>
                        <option value="RESTING">Resting</option>
                        <option value="SPAM_FLAGGED">Spam flagged</option>
                        <option value="RETIRED">Retired</option>
                      </select>
                      <Button type="submit" variant="ghost">
                        Set
                      </Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="text-sm text-zinc-500">No numbers yet. Without one, campaigns need a fixed caller ID.</p>
          )}
        </Card>

        <Card title="Texting" className="lg:col-span-2">
          <form action={saveTexting} className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-zinc-300">
              <input type="checkbox" name="textingEnabled" defaultChecked={((s.tenant.settings ?? {}) as { textingEnabled?: boolean }).textingEnabled !== false} className="h-4 w-4" /> Outbound texting on
            </label>
            <span className="text-xs text-zinc-500">Off = no pre-call, missed-call, agent or alert texts leave the system (they are logged as not sent). STOP and HELP confirmations still go out; carriers require them.</span>
            <Button type="submit" variant="ghost">
              Save
            </Button>
          </form>
        </Card>

        <TestPhonesCard settings={s.tenant.settings} tenantId={s.tenant.id} isAdmin={s.roles.includes("ADMIN")} />

        <Card title="Daily goals per agent" className="lg:col-span-2">
          <p className="mb-3 text-xs text-zinc-500">What the sprint bars on the agent screen count toward.</p>
          {(() => {
            const g = ((s.tenant.settings ?? {}) as { goals?: { dials?: number; contacts?: number; sales?: number } }).goals ?? {};
            return (
              <form action={saveGoals} className="flex flex-wrap items-end gap-3">
                <Field label="Dials">
                  <input name="dials" type="number" min="1" defaultValue={g.dials ?? 200} className={`${inputClass} w-28`} />
                </Field>
                <Field label="Contacts">
                  <input name="contacts" type="number" min="1" defaultValue={g.contacts ?? 20} className={`${inputClass} w-28`} />
                </Field>
                <Field label="Sales">
                  <input name="sales" type="number" min="1" defaultValue={g.sales ?? 3} className={`${inputClass} w-28`} />
                </Field>
                <Button type="submit" variant="ghost">
                  Save goals
                </Button>
              </form>
            );
          })()}
        </Card>

        <Card title="Call recordings: retention and nightly export" className="lg:col-span-2">
          <p className="mb-3 text-xs text-zinc-500">
            Recordings are kept {s.tenant.recordingRetentionDays} days, then forgotten (legal holds excepted). Every night the ones not yet exported are copied to your own storage first, so the
            long-term copy costs you nothing here. Exported so far: {exportedCount.toLocaleString()} · waiting: {pendingExport.toLocaleString()}.
          </p>
          <form action={saveRecordingPolicy} className="grid gap-3 md:grid-cols-4">
            <Field label="Keep recordings for (days)">
              <select name="retentionDays" defaultValue={s.tenant.recordingRetentionDays} className={inputClass}>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
              </select>
            </Field>
            <Field label="Nightly export to">
              <select name="exportType" defaultValue={exp?.type ?? "none"} className={inputClass}>
                <option value="none">Nowhere (just delete after retention)</option>
                <option value="sftp">SFTP server</option>
                <option value="dropbox">Dropbox</option>
              </select>
            </Field>
            <div className="md:col-span-2" />
            <Field label="SFTP host">
              <input name="sftpHost" defaultValue={exp?.type === "sftp" ? exp.host : ""} className={inputClass} placeholder="files.example.com" />
            </Field>
            <Field label="Port">
              <input name="sftpPort" type="number" defaultValue={exp?.type === "sftp" ? exp.port ?? 22 : 22} className={inputClass} />
            </Field>
            <Field label="Username">
              <input name="sftpUser" defaultValue={exp?.type === "sftp" ? exp.username : ""} className={inputClass} />
            </Field>
            <Field label="Password" hint="Stored encrypted. Leave blank to keep the current one.">
              <input name="sftpPassword" type="password" className={inputClass} />
            </Field>
            <Field label="SFTP folder">
              <input name="sftpPath" defaultValue={exp?.type === "sftp" ? exp.path : "/recordings"} className={inputClass} />
            </Field>
            <Field label="Dropbox access token" hint="From a Dropbox app with files.content.write. Stored encrypted.">
              <input name="dropboxToken" type="password" className={inputClass} />
            </Field>
            <Field label="Dropbox folder">
              <input name="dropboxPath" defaultValue={exp?.type === "dropbox" ? exp.path : "/Strowger"} className={inputClass} />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit">Save policy</Button>
            </div>
          </form>
          <form action={runRecordingExportNow} className="mt-3">
            <Button type="submit" variant="ghost">
              Run export now
            </Button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">Files land as {`<folder>/<YYYY-MM-DD>/<time>_<phone>_<callId>.wav`}. Export runs after 06:00 UTC each day.</p>
        </Card>

        <Card title="Campaign prompts" className="lg:col-span-2">
          <div className="grid gap-3 md:grid-cols-2">
            {campaigns.map((c) => (
              <form key={c.id} action={setCampaignAudio} className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm">
                <input type="hidden" name="campaignId" value={c.id} />
                <div className="font-medium">{c.name}</div>
                {(
                  [
                    ["safeHarborAudioId", "Safe harbor (abandoned call)", "SAFE_HARBOR", c.safeHarborAudioId],
                    ["voicemailDropAudioId", "Voicemail drop", "VOICEMAIL_DROP", c.voicemailDropAudioId],
                    ["screenerAudioId", "Screener answer", "SCREENER_MESSAGE", c.screenerAudioId],
                    ["disclosureAudioId", "Recording disclosure", "DISCLOSURE", c.disclosureAudioId],
                  ] as const
                ).map(([name, label, kind, cur]) => (
                  <Field key={name} label={label}>
                    <select name={name} defaultValue={cur ?? ""} className={inputClass}>
                      <option value="">none</option>
                      {byKind(kind).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
                <Button type="submit" variant="ghost">
                  Save
                </Button>
              </form>
            ))}
          </div>
        </Card>

        <Card title="Agent levels: what each level may do" className="lg:col-span-2">
          {(() => {
            const overrides = ((s.tenant.settings ?? {}) as { levelRights?: Record<string, string[]> }).levelRights ?? null;
            return (
              <form action={saveLevelRights} className="space-y-3">
                <p className="text-xs text-zinc-500">Every agent has a level (People → person). Supervisors and admins always have every right. Team leaders follow their level like any agent.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-zinc-500">
                        <th className="py-1 pr-2">Right</th>
                        {LEVELS.map((l) => (
                          <th key={l} className="px-2 py-1 text-center">
                            L{l}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(Object.keys(AGENT_RIGHTS) as (keyof typeof AGENT_RIGHTS)[]).map((r) => (
                        <tr key={r} className="border-t border-zinc-800">
                          <td className="py-1.5 pr-2 text-zinc-300">{AGENT_RIGHTS[r]}</td>
                          {LEVELS.map((l) => (
                            <td key={l} className="px-2 py-1.5 text-center">
                              <input type="checkbox" name={`level${l}`} value={r} defaultChecked={rightsForLevel(l, overrides).has(r)} className="h-4 w-4" />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button type="submit" variant="ghost">
                  Save levels
                </Button>
              </form>
            );
          })()}
        </Card>

        <Card title="Games: defaults for new campaigns" className="lg:col-span-2">
          {(() => {
            const g = { weeklyPoints: 10000, maxStake: 5000, ...(((s.tenant.settings ?? {}) as { games?: Record<string, unknown> }).games ?? {}) } as { weeklyPoints: number; maxStake: number };
            return (
              <form action={saveGames} className="flex flex-wrap items-end gap-3 text-sm">
                <p className="w-full text-xs text-zinc-500">
                  Bets and poker runs are switched on per campaign (campaign page → Games, or the{" "}
                  <Link href="/games" className="text-sky-300 underline">
                    Games
                  </Link>{" "}
                  page). These are only the starting values a new campaign gets.
                </p>
                <Field label="Points every Monday">
                  <input name="weeklyPoints" type="number" min={0} defaultValue={g.weeklyPoints} className={inputClass} />
                </Field>
                <Field label="Max stake per bet">
                  <input name="maxStake" type="number" min={1} defaultValue={g.maxStake} className={inputClass} />
                </Field>
                <Button type="submit" variant="ghost">
                  Save defaults
                </Button>
              </form>
            );
          })()}
        </Card>

        <div id="fcr" className="lg:col-span-2 scroll-mt-6" />
        <Card title="Free Caller Registry profile" className="lg:col-span-2">
          {(() => {
            const saved = ((s.tenant.settings ?? {}) as { fcr?: Record<string, string | { feedbackId?: string; at?: string; count?: number }> }).fcr ?? {};
            // Owner, 5 Nov: the first business on the platform. Pre-filled so the owner only presses Save.
            const seed: Record<string, string> = /national solar/i.test(s.tenant.name)
              ? { contactEmail: "numbers@crossbar.digital", companyName: "National Solar Resolutions", address1: "75 South Broadway", address2: "4th Floor", city: "White Plains", state: "NY", zip: "10601", website: "https://nationalsolarresolutions.com", contactPhone: "8336770003", category: "telemarketing", callCount: "10001" }
              : {};
            // Prefilled from the onboarding wizard's Business step; what was saved here wins.
            const f = { ...seed, ...fcrPrefill(s.tenant), ...saved };
            const v = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : "");
            const last = f.lastSubmission as { feedbackId?: string; at?: string; count?: number } | undefined;
            return (
              <form action={saveFcrProfile} className="space-y-3">
                <p className="text-xs text-zinc-500">
                  What the registry form (freecallerregistry.com: First Orion, Hiya and TNS) is filled with when you press &quot;Register now&quot; on the DIDs page. The contact email must be an address at
                  crossbar.digital: the registry emails a verification code there and Strowger reads it from Crossbar&apos;s inbox. By saving this you certify that this business makes the calls from
                  the numbers it registers.
                  {last?.feedbackId ? (
                    <>
                      {" "}
                      Last submission: feedback id <b>{last.feedbackId}</b>, {last.count} numbers, {last.at ? new Date(last.at).toLocaleString() : ""}.
                    </>
                  ) : null}
                </p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  <Field label="Contact email (at crossbar.digital)">
                    <input name="contactEmail" type="email" defaultValue={v("contactEmail") || "numbers@crossbar.digital"} className={inputClass} required />
                  </Field>
                  <Field label="Business name">
                    <input name="companyName" defaultValue={v("companyName") || s.tenant.name} className={inputClass} required />
                  </Field>
                  <Field label="Website">
                    <input name="website" defaultValue={v("website")} className={inputClass} placeholder="https://" required />
                  </Field>
                  <Field label="Street address">
                    <input name="address1" defaultValue={v("address1")} className={inputClass} required />
                  </Field>
                  <Field label="Suite / line 2">
                    <input name="address2" defaultValue={v("address2")} className={inputClass} />
                  </Field>
                  <Field label="City">
                    <input name="city" defaultValue={v("city")} className={inputClass} required />
                  </Field>
                  <Field label="State (2 letters)">
                    <input name="state" defaultValue={v("state")} maxLength={2} className={inputClass} required />
                  </Field>
                  <Field label="ZIP">
                    <input name="zip" defaultValue={v("zip")} className={inputClass} required />
                  </Field>
                  <Field label="Contact name">
                    <input name="contactName" defaultValue={v("contactName") || `${s.user.firstName ?? ""}`.trim()} className={inputClass} required />
                  </Field>
                  <Field label="Contact phone">
                    <input name="contactPhone" defaultValue={v("contactPhone")} className={inputClass} placeholder="3055550100" required />
                  </Field>
                  <Field label="Call purpose">
                    <select name="category" defaultValue={v("category") || "telemarketing"} className={inputClass}>
                      <option value="attorney_legal">Attorney / Law</option>
                      <option value="financial_service">Financial Services</option>
                      <option value="health">Health / Hospital</option>
                      <option value="informational">Informational</option>
                      <option value="real_estate">Real Estate</option>
                      <option value="survey">Survey / Research</option>
                      <option value="telemarketing">Telemarketing</option>
                      <option value="political">Political / Campaign</option>
                      <option value="school_college">School / College</option>
                      <option value="government">Government</option>
                    </select>
                  </Field>
                  <Field label="Outbound calls per month">
                    <select name="callCount" defaultValue={v("callCount") || "10001"} className={inputClass}>
                      <option value="1">1 - 100</option>
                      <option value="101">101 - 500</option>
                      <option value="501">501 - 1,000</option>
                      <option value="1001">1,001 - 5,000</option>
                      <option value="5001">5,001 - 10,000</option>
                      <option value="10001">10,001 - 50,000</option>
                      <option value="50001">More than 50,000</option>
                    </select>
                  </Field>
                </div>
                <Field label="Feedback from customers about how your calls are labelled (optional)">
                  <input name="explanation" defaultValue={v("explanation")} className={inputClass} />
                </Field>
                <Button type="submit" variant="ghost">
                  Save profile
                </Button>
              </form>
            );
          })()}
        </Card>
      </div>
    </div>
  );
}


/** Test phones: the owner's own numbers dial outside calling hours for 12 hours (owner, 6 Nov). */
async function TestPhonesCard({ settings, tenantId, isAdmin }: { settings: unknown; tenantId: string; isAdmin: boolean }) {
  const current = readTestPhones(settings);
  const on = testPhonesOn(current) ? current : null;
  // Pre-fill: the last list, plus every active transfer destination in the workspace.
  const dests = await prisma.transferDestination.findMany({ where: { tenantId, active: true }, select: { phone: true, name: true } });
  const destTen = dests.map((d) => d.phone.replace(/\D/g, "").slice(-10)).filter((p) => p.length === 10);
  const prefill = [...new Set([...(current?.phones ?? []), ...DEFAULT_TEST_PHONES, ...destTen])];
  return (
    <Card title="Test phones: ignore calling hours" className="lg:col-span-2">
      <p className="mb-3 text-xs text-zinc-500">
        For testing on your own phones. Numbers listed here can be dialled outside the calling window and past the daily attempt cap, for {TEST_PHONES_HOURS} hours or, with &quot;Always on&quot;, until an admin turns it off.
        Every other number keeps the federal and state hours. Do-not-call still applies. Texts keep normal hours.
      </p>
      {on ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          <span className="font-medium">On</span>
          <span>
            {on.always || !on.until ? "always, 24/7," : <>until <TestPhonesUntil iso={on.until} /></>} for {on.phones.map((p) => formatPhone(p)).join(", ")}
          </span>
          {isAdmin ? (
            <form action={turnOffTestPhones}>
              <Button type="submit" variant="ghost">
                Turn off now
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {isAdmin ? (
        <form action={turnOnTestPhones} className="flex flex-wrap items-end gap-3 text-sm">
          <Field label="Phones (up to 10, one per line or comma separated)">
            <textarea name="phones" rows={3} defaultValue={prefill.map((p) => formatPhone(p)).join("\n")} className={`${inputClass} w-72 font-mono`} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-zinc-300">
            <input type="checkbox" name="always" defaultChecked={on?.always ?? true} className="h-4 w-4" /> Always on (24/7, no expiry)
          </label>
          <Button type="submit">{on ? "Save test phones" : "Turn on"}</Button>
          {dests.length ? <span className="text-xs text-zinc-500">Includes the transfer destinations: {dests.map((d) => d.name).join(", ")}.</span> : null}
        </form>
      ) : (
        <p className="text-xs text-zinc-500">Only an admin can turn this on.</p>
      )}
    </Card>
  );
}
