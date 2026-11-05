import { prisma } from "@strowger/db";
import { ROLES } from "@strowger/shared";
import { notFound } from "next/navigation";
import { hasRole, requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { resetSipPassword, setCampaignAssignment, setUserAffiliate, updatePerson } from "../actions";

export default async function PersonPage({ params, searchParams }: PageProps<"/people/[id]">) {
  const s = await requireRole("SUPERVISOR");
  const { id } = await params;
  const { sip } = await searchParams;
  const [p, campaigns, affiliates] = await Promise.all([
    prisma.user.findFirst({ where: { id, tenantId: s.tenant.id }, include: { campaignAgents: true } }),
    prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: { not: "ARCHIVED" } }, orderBy: { name: "asc" } }),
    prisma.affiliate.findMany({ where: { tenantId: s.tenant.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!p) notFound();
  const shownSip = typeof sip === "string" ? sip : null;
  const realm = process.env.JAMBONZ_SIP_REALM ?? "";

  return (
    <div>
      <PageHeader title={p.firstName || p.lastName ? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() : p.email} subtitle={p.email} />

      {shownSip ? (
        <Notice kind="warn">
          <div className="font-medium">Softphone password, shown once.</div>
          <div className="mt-1 font-mono text-sm">
            user <span className="select-all">{p.sipUsername}</span>
            {realm ? <> @ {realm}</> : null} · password <span className="select-all">{shownSip}</span>
          </div>
          <div className="mt-1 text-xs">The agent screen signs in with these automatically; the agent only needs them for an external SIP phone.</div>
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Account">
          <form action={updatePerson} className="space-y-3">
            <input type="hidden" name="id" value={p.id} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <input name="firstName" defaultValue={p.firstName ?? ""} className={inputClass} />
              </Field>
              <Field label="Last name">
                <input name="lastName" defaultValue={p.lastName ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Agent level (1–8)" hint="Rights per level are set under Settings → Agent levels.">
                <select name="level" defaultValue={String(p.level)} className={inputClass}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => (
                    <option key={l} value={l}>
                      Level {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Mobile (voicemail alerts by text)">
                <input name="mobilePhone" defaultValue={p.mobilePhone ?? ""} className={inputClass} placeholder="3055550100" />
              </Field>
            </div>
            <fieldset className="space-y-1 text-sm">
              <legend className="text-zinc-300">Roles</legend>
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-zinc-300">
                  <input type="checkbox" name="roles" value={r} defaultChecked={p.roles.includes(r)} disabled={r === "ADMIN" && !hasRole(s)} className="h-4 w-4" />
                  {r.replace("_", " ").toLowerCase()}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" name="active" defaultChecked={p.active} className="h-4 w-4" /> Active
            </label>
            <Button type="submit">Save</Button>
          </form>
        </Card>

        <Card title="Softphone line">
          <div className="space-y-3 text-sm">
            <div>
              Username: <span className="font-mono">{p.sipUsername ?? "none"}</span>
              {p.sipUsername ? <Badge tone="green">issued</Badge> : null}
            </div>
            <p className="text-xs text-zinc-500">The password is stored encrypted and used by the agent screen automatically. Reset it if it leaks or an external phone needs it.</p>
            <form action={resetSipPassword}>
              <input type="hidden" name="id" value={p.id} />
              <Button type="submit" variant="ghost">
                {p.sipUsername ? "Reset password" : "Issue a line"}
              </Button>
            </form>
          </div>
        </Card>

        {p.roles.includes("AFFILIATE") ? (
          <Card title="Partner link" className="lg:col-span-2">
            <form action={setUserAffiliate} className="flex items-end gap-2">
              <input type="hidden" name="id" value={p.id} />
              <div className="w-80">
                <Field label="This person sees the portal for">
                  <select name="affiliateId" defaultValue={p.affiliateId ?? ""} className={inputClass}>
                    <option value="">Not linked</option>
                    {affiliates.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="submit" variant="ghost">
                Save
              </Button>
            </form>
          </Card>
        ) : null}

        <Card title="Campaigns" className="lg:col-span-2">
          <div className="grid gap-2 md:grid-cols-2">
            {campaigns.map((c) => {
              const cur = p.campaignAgents.find((ca) => ca.campaignId === c.id);
              return (
                <form key={c.id} action={setCampaignAssignment} className="flex items-center gap-2 rounded-md border border-zinc-800 p-2 text-sm">
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="campaignId" value={c.id} />
                  <div className="flex-1 truncate">{c.name}</div>
                  <select name="agentMode" defaultValue={cur?.agentMode ?? "NONE"} className={`${inputClass} w-40`}>
                    <option value="NONE">Not assigned</option>
                    <option value="BOTH">Fronter + closer</option>
                    <option value="FRONTER">Fronter</option>
                    <option value="CLOSER">Closer</option>
                  </select>
                  <Button type="submit" variant="ghost">
                    Save
                  </Button>
                </form>
              );
            })}
            {campaigns.length === 0 ? <p className="text-sm text-zinc-500">No campaigns yet.</p> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
