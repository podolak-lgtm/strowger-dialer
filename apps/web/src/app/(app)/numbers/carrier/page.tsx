import { requireClientWorkspace } from "@/lib/auth";
import { Button, Card, Notice, PageHeader } from "@/components/ui";
import { runSetup } from "../actions";
import { Flash, Row, provisionStatus, setupComplete } from "../parts";

/**
 * Carrier setup tab: the one-time Telnyx voice connection, jambonz carrier
 * and messaging profile. The tab label carries a ✓ once all three exist
 * (section-status.tsx). Split out of /numbers on 7 Nov; the action is unchanged.
 */
export default async function CarrierPage({ searchParams }: PageProps<"/numbers/carrier">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const sp = await searchParams;
  const { status, error: statusError } = await provisionStatus(s.tenant.id);
  const setupDone = setupComplete(status);

  return (
    <div>
      <PageHeader title="Carrier setup" subtitle="Done once per workspace: the voice trunk numbers dial through, the jambonz carrier that routes them, and the texting profile replies arrive on." />
      <Flash sp={sp} engineError={statusError} />
      <Card title={setupDone ? "Carrier setup ✓ done" : "Carrier setup (once)"} className="max-w-3xl">
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
                    {status.connection.name} → inbound to <code className="break-all">{status.connection.fqdn ?? status.sbcFqdn}</code>
                  </>
                ) : (
                  <>will point inbound calls at <code className="break-all">{status.sbcFqdn || "(no SBC address)"}</code></>
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
    </div>
  );
}
