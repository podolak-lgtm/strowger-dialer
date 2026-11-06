// Railway: the public GraphQL API (https://backboard.railway.com/graphql/v2),
// with an account or workspace token (Authorization: Bearer). The schema was
// read by introspection on 6 Nov 2026; none of it has been run with our token.
//
//   usage(workspaceId, startDate, endDate, measurements, groupBy: [PROJECT_ID, SERVICE_ID])
//       vCPU-minutes, GB-minutes of memory and disk, GB of egress per service for the calendar month so far,
//       priced at Railway's published rates (RAILWAY_RATES): one running-total row per service (source api).
//   workspace(workspaceId) { customer { currentUsage creditBalance invoices { … } } }
//       Railway's own figure for the cycle (reconciliation), the credit balance, and the invoices: each
//       paid or open invoice is written as an invoice (its total, its PDF archived), which replaces the
//       running total and any fixed Railway cost for its month.
import { RAILWAY_RATES, railwayCostMillicents, type RailwayMeasurement } from "@strowger/shared/vendor-collect";
import type { Connector, FoundInvoice, PeriodRow } from "./types";
import { monthStart, periodOf } from "./types";

const URL_V2 = "https://backboard.railway.com/graphql/v2";

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(URL_V2, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok || body?.errors?.length || !body?.data) throw new Error(`Railway API: ${res.status} ${body?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim().slice(0, 300));
  return body.data;
}

interface Usage {
  measurement: RailwayMeasurement;
  value: number;
  tags: { projectId: string | null; serviceId: string | null };
}
interface Invoice {
  invoiceId: string;
  total: number;
  status: string;
  periodStart: string;
  periodEnd: string;
  pdfURL: string | null;
}

export const railway: Connector = {
  vendor: "railway",
  label: "Railway",
  method: "api",
  collects: "Usage per service this month at Railway's rates, Railway's own month figure and credit balance, and every invoice (total and PDF)",
  whereToGet: "railway.com → Account Settings → Tokens: create an account token (or a workspace token for the Strowger workspace). The workspace id is optional: in the dashboard URL after /workspace/ or in Workspace Settings.",
  credentials: [
    { key: "token", label: "Account or workspace token", secret: true },
    { key: "workspaceId", label: "Workspace id (optional: the first workspace when blank)", secret: false, optional: true },
  ],
  missing: (c) => (c.token ? null : "Enter a Railway account or workspace token"),
  async collect({ now, creds, step }) {
    const token = creds.token!;
    await step("signing in", "Asking Railway which workspace the token reaches");
    let workspaceId = creds.workspaceId?.trim();
    if (!workspaceId) {
      const me = await gql<{ me: { workspaces: { id: string; name: string }[] } }>(token, "query { me { workspaces { id name } } }", {});
      workspaceId = me.me.workspaces[0]?.id;
      if (!workspaceId) throw new Error("The token reaches no Railway workspace; save the workspace id");
    }
    const period = periodOf(now);
    await step("downloading", "Reading usage, the bill so far and invoices");
    const d = await gql<{
      workspace: { name: string; customer: { currentUsage: number; creditBalance: number; billingPeriod: { start: string; end: string } | null; invoices: Invoice[] }; projects: { edges: { node: { id: string; name: string; services: { edges: { node: { id: string; name: string } }[] } } }[] } };
      usage: Usage[];
    }>(
      token,
      `query ($ws: String!, $start: DateTime!, $end: DateTime!, $m: [MetricMeasurement!]!) {
        workspace(workspaceId: $ws) {
          name
          customer { currentUsage creditBalance billingPeriod { start end } invoices { invoiceId total status periodStart periodEnd pdfURL } }
          projects(first: 100) { edges { node { id name services { edges { node { id name } } } } } }
        }
        usage(workspaceId: $ws, startDate: $start, endDate: $end, measurements: $m, groupBy: [PROJECT_ID, SERVICE_ID]) { measurement value tags { projectId serviceId } }
      }`,
      { ws: workspaceId, start: monthStart(now).toISOString(), end: now.toISOString(), m: Object.keys(RAILWAY_RATES) },
    );

    const names = new Map<string, string>();
    for (const p of d.workspace.projects.edges) {
      names.set(p.node.id, p.node.name);
      for (const s of p.node.services.edges) names.set(s.node.id, `${p.node.name} / ${s.node.name}`);
    }
    const byService = new Map<string, Partial<Record<RailwayMeasurement, number>>>();
    for (const u of d.usage) {
      const k = u.tags.serviceId ?? u.tags.projectId ?? "workspace";
      const m = byService.get(k) ?? {};
      m[u.measurement] = (m[u.measurement] ?? 0) + u.value;
      byService.set(k, m);
    }
    const rows: PeriodRow[] = [...byService.entries()].map(([id, m]) => ({ period, part: id, kind: "hosting", millicents: railwayCostMillicents(m), quantity: m.CPU_USAGE ?? 0, label: names.get(id) ?? id }));

    // Finished invoices only; a draft is still moving.
    const invoices: FoundInvoice[] = [];
    for (const inv of d.workspace.customer.invoices.filter((i) => /paid|open|uncollectible/i.test(i.status)).slice(0, 6)) {
      let file: FoundInvoice["file"];
      if (inv.pdfURL) {
        const pdf = await fetch(inv.pdfURL, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        const bytes = pdf?.ok ? Buffer.from(await pdf.arrayBuffer()) : null;
        if (bytes && bytes.subarray(0, 4).toString() === "%PDF") file = { bytes, type: "pdf" };
      }
      // The API's total is in cents (Stripe); it is the figure written. The PDF is kept for the record.
      invoices.push({ invoiceNumber: inv.invoiceId, periodStart: inv.periodStart, periodEnd: inv.periodEnd, totalCents: Math.round(inv.total), currency: "USD", lines: [{ description: `Railway invoice ${inv.invoiceId}`, quantity: 1, amount: Math.round(inv.total) / 100 }], file });
    }
    const c = d.workspace.customer;
    return {
      periods: [period],
      rows,
      invoices,
      balanceCents: Math.round(c.creditBalance * 100),
      reported: { period, cents: Math.round(c.currentUsage * 100) },
      note: `Workspace ${d.workspace.name}${c.billingPeriod ? `, cycle ${c.billingPeriod.start.slice(0, 10)} to ${c.billingPeriod.end.slice(0, 10)}` : ""}`,
    };
  },
};
