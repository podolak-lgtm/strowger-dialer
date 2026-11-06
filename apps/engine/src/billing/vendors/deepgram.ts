// Deepgram (speech to text through jambonz): Manage API with a key that can read billing (Authorization: Token <key>).
//   GET /v1/projects                                  the projects the key reaches (unless a project id is saved)
//   GET /v1/projects/{id}/balances                    prepaid balances (amount, units)
//   GET /v1/projects/{id}/billing/breakdown?start&end  dollars for the month so far
// Our transcription cost is already counted per use (minutes × rate, with the client), so Deepgram's dollars are
// shown beside ours for reconciliation, never added (reconcile-only). Not yet run with our key.
import type { Connector } from "./types";
import { monthStart, periodOf } from "./types";

const API = "https://api.deepgram.com/v1";

async function dg<T>(key: string, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { authorization: `Token ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Deepgram ${path.split("?")[0]}: ${res.status} ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

export const deepgram: Connector = {
  vendor: "deepgram",
  label: "Deepgram (speech to text)",
  method: "api",
  collects: "Prepaid balance and the month's charges in dollars (shown beside our per-minute count)",
  whereToGet: "console.deepgram.com → the project → API Keys: create a key with the Administrator or Owner role (Member keys cannot read billing). The project id is optional.",
  credentials: [
    { key: "apiKey", label: "API key (Administrator role)", secret: true },
    { key: "projectId", label: "Project id (optional: every project the key reaches)", secret: false, optional: true },
  ],
  missing: (c) => (c.apiKey ? null : "Enter a Deepgram API key"),
  async collect({ now, creds, step }) {
    const key = creds.apiKey!;
    await step("signing in", "Listing Deepgram projects");
    const ids = creds.projectId?.trim() ? [creds.projectId.trim()] : (await dg<{ projects: { project_id: string }[] }>(key, "/projects")).projects.map((p) => p.project_id);
    if (!ids.length) throw new Error("The key reaches no Deepgram project");
    await step("downloading", "Reading balances and this month's charges");
    let balance = 0;
    let dollars = 0;
    const start = monthStart(now).toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    for (const id of ids) {
      const b = await dg<{ balances: { amount: number; units: string }[] }>(key, `/projects/${id}/balances`);
      for (const x of b.balances ?? []) if (!x.units || /usd/i.test(x.units)) balance += Number(x.amount) || 0;
      const br = await dg<{ results: { dollars: number }[] }>(key, `/projects/${id}/billing/breakdown?start=${start}&end=${end}`);
      for (const r of br.results ?? []) dollars += Number(r.dollars) || 0;
    }
    return { balanceCents: Math.round(balance * 100), reported: { period: periodOf(now), cents: Math.round(dollars * 100) }, note: `${ids.length} project${ids.length === 1 ? "" : "s"}` };
  },
};
