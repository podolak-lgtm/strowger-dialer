import { prisma } from "@strowger/db";
import { decryptString, mintRealtimeToken } from "@strowger/shared/secrets";
import { requireRole } from "@/lib/auth";
import { BUILD_ID } from "@/lib/version";
import { AgentConsole, type ConsoleProps } from "./console";
import { rightsOf } from "@/lib/rights";
import { billingStatus } from "@/lib/billing-actions";

export default async function AgentPage({ searchParams }: PageProps<"/agent">) {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const { screen } = await searchParams;

  const assigned = await prisma.campaignAgent.findMany({
    where: { userId: s.user.id, campaign: { status: "ACTIVE" } },
    include: { campaign: { include: { dispositions: { where: { active: true }, orderBy: { sortOrder: "asc" } } } } },
  });
  // Supervisors may work any active campaign.
  const extra =
    s.roles.includes("SUPERVISOR") || s.roles.includes("ADMIN")
      ? await prisma.campaign.findMany({ where: { tenantId: s.tenant.id, status: "ACTIVE", id: { notIn: assigned.map((a) => a.campaignId) } }, include: { dispositions: { where: { active: true }, orderBy: { sortOrder: "asc" } } } })
      : [];

  const campaigns: ConsoleProps["campaigns"] = [
    ...assigned.map((a) => ({ id: a.campaign.id, name: a.campaign.name, dialMode: a.campaign.dialMode, agentMode: a.agentMode, outboundOn: a.outboundOn, closersMayDial: a.campaign.closersMayDial, wrapUpSeconds: a.campaign.wrapUpSeconds, callbackOwnerMinutes: a.campaign.callbackOwnerMinutes, dispositions: a.campaign.dispositions.map((d) => ({ id: d.id, code: d.code, label: d.label, hotkey: d.hotkey, isCallback: d.isCallback, isSale: d.isSale, isDnc: d.isDnc })) })),
    ...extra.map((c) => ({ id: c.id, name: c.name, dialMode: c.dialMode, agentMode: "BOTH" as const, outboundOn: true, closersMayDial: c.closersMayDial, wrapUpSeconds: c.wrapUpSeconds, callbackOwnerMinutes: c.callbackOwnerMinutes, dispositions: c.dispositions.map((d) => ({ id: d.id, code: d.code, label: d.label, hotkey: d.hotkey, isCallback: d.isCallback, isSale: d.isSale, isDnc: d.isDnc })) })),
  ];

  const billing = await billingStatus();
  const secret = process.env.ENGINE_INTERNAL_KEY ?? "";
  const sipPassword = s.user.sipSecret ? decryptString(s.user.sipSecret, secret) : null;

  return (
    <AgentConsole
      me={{ id: s.user.id, name: s.user.firstName ?? s.user.email.split("@")[0]!, tenant: s.tenant.name }}
      roles={s.roles}
      rights={[...rightsOf(s)]}
      billing={billing ? { balanceCents: billing.balanceCents, low: billing.low, critical: billing.critical, suspended: billing.suspended, isPlatform: billing.isPlatform, graceDays: billing.graceDays } : null}
      campaigns={campaigns}
      sip={
        s.user.sipUsername && sipPassword
          ? { server: process.env.JAMBONZ_WSS_URL ?? "wss://sip.jambonz.cloud:8443", realm: process.env.JAMBONZ_SIP_REALM ?? "", username: s.user.sipUsername, password: sipPassword, applicationSid: process.env.JAMBONZ_APPLICATION_SID ?? "" }
          : null
      }
      engineUrl={process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4000"}
      rtToken={mintRealtimeToken({ tenantId: s.tenant.id, userId: s.user.id, roles: s.roles }, secret, 8 * 3600)}
      screen={screen === "assist" ? "assist" : "main"}
      version={BUILD_ID}
    />
  );
}
