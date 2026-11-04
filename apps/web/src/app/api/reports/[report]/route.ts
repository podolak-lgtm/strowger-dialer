// CSV exports: /api/reports/{calls,dispositions,agents}.csv?from&to&campaign
import { requireRole } from "@/lib/auth";
import { agentName, byAgent, byDisposition, callRows, csv, parseRange } from "@/lib/reports";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/reports/[report]">) {
  const s = await requireRole("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const { report } = await ctx.params;
  const url = new URL(req.url);
  const range = parseRange(s.tenant.id, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, campaign: url.searchParams.get("campaign") ?? undefined });
  const rows = await callRows(range);

  let body: string;
  if (report === "calls.csv") {
    body = csv(
      rows.map((c) => ({
        dialed_at: c.dialedAt,
        campaign: c.campaign?.name ?? "",
        agent: agentName(c.agent),
        direction: c.direction,
        phone: c.phone,
        caller_id: c.callerId ?? "",
        lead_first_name: c.lead?.firstName ?? "",
        lead_last_name: c.lead?.lastName ?? "",
        lead_state: c.lead?.state ?? "",
        list: c.lead?.list.name ?? "",
        answered_at: c.answeredAt,
        bridged_at: c.bridgedAt,
        ended_at: c.endedAt,
        talk_seconds: c.bridgedAt && c.endedAt ? Math.round((c.endedAt.getTime() - c.bridgedAt.getTime()) / 1000) : "",
        amd: c.amdResult ?? "",
        outcome: c.outcome ?? "",
        abandoned: c.abandoned,
        disposition: c.disposition?.code ?? "",
        is_sale: c.disposition?.isSale ?? false,
        notes: c.notes ?? "",
        recording_url: c.recordingUrl ?? "",
      })),
    );
  } else if (report === "dispositions.csv") {
    body = csv(byDisposition(rows).map((d) => ({ code: d.code, label: d.label, count: d.count })));
  } else if (report === "agents.csv") {
    body = csv(byAgent(rows).map((a) => ({ agent: a.agent, dials: a.dials, connected: a.connected, contacts: a.contacts, sales: a.sales, talk_seconds: Math.round(a.talkSeconds) })));
  } else {
    return new Response("unknown report", { status: 404 });
  }
  const name = `${report.replace(".csv", "")}_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`;
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
}
