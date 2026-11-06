// Cartesia (text to speech): it has a usage API, so no browser.
//   GET https://api.cartesia.ai/usage/credits?start_ts&end_ts   credits used, admin key (sk_car_admin_…), Cartesia-Version header
// Cartesia bills a plan with included credits, so credits are not dollars: the month's credits go on the Balances
// line, the cost stays the per-character usage rate (or the plan as a fixed cost, or the plan's invoice uploaded,
// which replaces the fixed cost). No balance API exists. Not yet run with our key.
import { config } from "../../config";
import type { Connector } from "./types";
import { monthStart } from "./types";

export const cartesia: Connector = {
  vendor: "cartesia",
  label: "Cartesia (text to speech)",
  method: "api",
  collects: "Credits used this month (the cost stays characters × rate, or the plan; upload the plan's invoice to replace the fixed cost)",
  whereToGet: "play.cartesia.ai/keys/admin: create an admin key (it starts sk_car_admin_).",
  credentials: [{ key: "adminKey", label: "Admin key (sk_car_admin_…)", secret: true }],
  missing: (c) => (c.adminKey ? null : "Enter a Cartesia admin key"),
  async collect({ now, creds, step }) {
    await step("downloading", "Reading Cartesia credit usage for the month");
    const u = new URL("https://api.cartesia.ai/usage/credits");
    u.searchParams.set("start_ts", monthStart(now).toISOString().replace(/\.\d{3}Z$/, "Z"));
    u.searchParams.set("end_ts", now.toISOString().replace(/\.\d{3}Z$/, "Z"));
    const res = await fetch(u, { headers: { authorization: `Bearer ${creds.adminKey}`, "Cartesia-Version": config.CARTESIA_API_VERSION, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Cartesia usage: ${res.status} ${text.slice(0, 160)}`);
    const body = JSON.parse(text) as { data?: { credits?: number }[] };
    const credits = (body.data ?? []).reduce((n, b) => n + (Number(b.credits) || 0), 0);
    return { note: `${credits.toLocaleString("en-US")} credits used this month` };
  },
};
