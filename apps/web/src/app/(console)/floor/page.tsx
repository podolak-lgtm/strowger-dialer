import { decryptString, mintRealtimeToken } from "@strowger/shared/secrets";
import { requireRole } from "@/lib/auth";
import { FloorConsole } from "./floor";

export default async function FloorPage({ searchParams }: PageProps<"/floor">) {
  const s = await requireRole("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const { view, campaign } = await searchParams;
  const secret = process.env.ENGINE_INTERNAL_KEY ?? "";
  const sipPassword = s.user.sipSecret ? decryptString(s.user.sipSecret, secret) : null;
  return (
    <FloorConsole
      me={{ id: s.user.id, name: s.user.firstName ?? s.user.email.split("@")[0]!, role: s.roles.includes("ADMIN") ? "Admin" : s.roles.includes("SUPERVISOR") ? "Supervisor" : s.roles.includes("ROOM_SUPERVISOR") ? "Room supervisor" : "Team leader" }}
      view={view === "campaign" ? "campaign" : "agents"}
      initialCampaignId={typeof campaign === "string" ? campaign : null}
      engineUrl={process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4000"}
      rtToken={mintRealtimeToken({ tenantId: s.tenant.id, userId: s.user.id, roles: s.roles }, secret, 8 * 3600)}
      sip={
        s.user.sipUsername && sipPassword
          ? { server: process.env.JAMBONZ_WSS_URL ?? "wss://sip.jambonz.cloud:8443", realm: process.env.JAMBONZ_SIP_REALM ?? "", username: s.user.sipUsername, password: sipPassword }
          : null
      }
    />
  );
}
