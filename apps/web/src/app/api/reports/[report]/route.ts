// CSV exports: /api/reports/{calls,dispositions,agents}.csv?from&to&campaign
//              /api/reports/{inbound,inbound-queues,inbound-agents}.csv?from&to&queue
import { requireRole } from "@/lib/auth";
import { agentName, byAgent, byDisposition, callRows, csv, parseRange } from "@/lib/reports";
import { inboundReport, isOffered } from "@/lib/inbound-report";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/reports/[report]">) {
  const s = await requireRole("SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const { report } = await ctx.params;
  const url = new URL(req.url);
  const range = parseRange(s.tenant.id, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, campaign: url.searchParams.get("campaign") ?? undefined });
  let body: string;
  if (report.startsWith("inbound")) {
    const rep = await inboundReport(range, url.searchParams.get("queue") || null);
    if (report === "inbound.csv") {
      body = csv(
        rep.calls.map((c) => ({
          queued_at: c.queuedAt,
          queue: c.queue?.name ?? "",
          kind: c.direction === "OUTBOUND" ? "queue callback" : c.outcome === "CANCELLED" ? "asked for callback" : "inbound",
          counted_as_offered: isOffered(c),
          phone: c.phone,
          number_called: c.direction === "INBOUND" ? (c.callerId ?? "") : "",
          lead: [c.lead?.firstName, c.lead?.lastName].filter(Boolean).join(" "),
          vip: c.lead?.vip ?? false,
          agent: c.agentId ? agentName(c.agent) : "",
          wait_seconds: c.waitSeconds ?? "",
          answered: Boolean(c.bridgedAt),
          within_sla: c.bridgedAt && c.waitSeconds !== null && c.queue ? c.waitSeconds <= c.queue.slaSeconds : "",
          abandoned_in_queue: c.abandonedInQueue,
          bridged_at: c.bridgedAt,
          talk_seconds: c.bridgedAt && (c.surveyStartedAt ?? c.endedAt) ? Math.round(((c.surveyStartedAt ?? c.endedAt)!.getTime() - c.bridgedAt.getTime()) / 1000) : "",
          wrap_seconds: c.wrapEndedAt && (c.surveyStartedAt ?? c.endedAt) ? Math.max(0, Math.round((c.wrapEndedAt.getTime() - (c.surveyStartedAt ?? c.endedAt)!.getTime()) / 1000)) : "",
          survey_score: c.surveyScore ?? "",
          outcome: c.outcome ?? "",
          notes: c.notes ?? "",
        })),
      );
    } else if (report === "inbound-queues.csv") {
      body = csv(
        rep.byQueue.map((x) => ({
          queue: x.name,
          offered: x.offered,
          answered: x.answered,
          abandoned: x.abandoned,
          overflowed: x.overflowed,
          sla_seconds: x.slaSeconds,
          service_level_pct: x.serviceLevelPct,
          asa_seconds: x.asaSeconds,
          abandon_rate_pct: x.abandonRatePct,
          aht_seconds: x.ahtSeconds,
          longest_wait_seconds: x.longestWaitSeconds,
          fcr_pct: x.fcrPct,
          callbacks_requested: x.callbacksRequested,
          callbacks_done: x.callbacksDone,
          callbacks_failed: x.callbacksFailed,
          surveys: x.surveys,
          survey_avg: x.surveyAvg ?? "",
        })),
      );
    } else if (report === "inbound-agents.csv") {
      body = csv(rep.agents.map((a) => ({ agent: a.agent, answered: a.answered, aht_seconds: a.ahtSeconds, talk_seconds: a.talkSeconds, wrap_seconds: a.wrapSeconds, occupancy_pct: a.occupancyPct, idle_seconds: a.idleSeconds, survey_avg: a.surveyAvg ?? "" })));
    } else {
      return new Response("unknown report", { status: 404 });
    }
    const name = `${report.replace(".csv", "")}_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`;
    return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
  }
  const rows = await callRows(range);

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
