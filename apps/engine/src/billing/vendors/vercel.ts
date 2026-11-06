// Vercel: GET https://api.vercel.com/v1/billing/charges?teamId=&from=&to= (FOCUS v1.3 charges as JSONL; Pro and
// Enterprise teams; the token's user needs Owner, Member, Developer, Security, Billing or Enterprise Viewer).
// Summed per service and project for this month and last (last month's charges settle after the 1st), written as
// running-total rows (source api). Not yet run with our token.
import { aggregateFocus } from "@strowger/shared/vendor-collect";
import type { Connector, PeriodRow } from "./types";
import { monthStart, periodOf, prevMonth } from "./types";

async function charges(token: string, teamId: string, from: Date, to: Date): Promise<string> {
  const u = new URL("https://api.vercel.com/v1/billing/charges");
  u.searchParams.set("teamId", teamId);
  u.searchParams.set("from", from.toISOString());
  u.searchParams.set("to", to.toISOString());
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept: "application/jsonl, application/json" }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel billing charges: ${res.status} ${text.slice(0, 200)}`);
  return text;
}

export const vercel: Connector = {
  vendor: "vercel",
  label: "Vercel",
  method: "api",
  collects: "Every billed charge (FOCUS) by service and project, this month and last",
  whereToGet: "vercel.com → Account Settings → Tokens: create a token scoped to the team. The team id is in Team Settings → General (team_…).",
  credentials: [
    { key: "token", label: "Access token", secret: true },
    { key: "teamId", label: "Team id (team_…)", secret: false },
  ],
  missing: (c) => (!c.token ? "Enter a Vercel access token" : !c.teamId ? "Enter the Vercel team id" : null),
  async collect({ now, creds, step }) {
    await step("downloading", "Reading Vercel's billing charges for this month and last");
    const last = prevMonth(now);
    const thisMonth = monthStart(now);
    const rows: PeriodRow[] = [];
    for (const [from, to] of [
      [last, thisMonth],
      [thisMonth, now],
    ] as const) {
      const period = periodOf(from);
      for (const r of aggregateFocus(await charges(creds.token!, creds.teamId!, from, to), period)) rows.push({ period, part: r.part, kind: r.kind, millicents: r.millicents, quantity: r.quantity, label: r.label });
    }
    return { periods: [periodOf(last), periodOf(now)], rows, note: `${rows.length} charge line${rows.length === 1 ? "" : "s"} over two months` };
  },
};
