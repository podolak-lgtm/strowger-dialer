import { prisma } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { addAudioAsset, addCallerIds, deleteAudioAsset, setCallerIdStatus, setCampaignAudio } from "./actions";

const KINDS = ["SAFE_HARBOR", "VOICEMAIL_DROP", "SCREENER_MESSAGE", "DISCLOSURE", "HOLD", "OTHER"] as const;

export default async function SettingsPage() {
  const s = await requireRole("SUPERVISOR");
  const [audio, callerIds, campaigns] = await Promise.all([
    prisma.audioAsset.findMany({ where: { tenantId: s.tenant.id }, orderBy: { createdAt: "desc" } }),
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id }, orderBy: [{ status: "asc" }, { areaCode: "asc" }] }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" } }),
  ]);
  const byKind = (k: string) => audio.filter((a) => a.kind === k || a.kind === "OTHER");

  return (
    <div>
      <PageHeader title="Settings" subtitle={`${s.tenant.name} · workspace ${s.tenant.slug}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Audio files">
          <p className="mb-3 text-xs text-zinc-500">
            Prompts the dialer plays: safe-harbor on an abandoned call, voicemail drop, the screener answer, and the recording disclosure. Give a public https URL to an
            MP3 or WAV (8 kHz mono WAV plays cleanest). Uploads come later.
          </p>
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
      </div>
    </div>
  );
}
