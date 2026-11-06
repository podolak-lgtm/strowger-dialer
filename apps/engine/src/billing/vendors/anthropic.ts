// Anthropic, wrapping the Admin API cost report (billing/vendor.ts) as a connector. It stays reconciliation-only:
// per-request cost is recorded from token usage; the cost report is Anthropic's own month figure (it may include
// other use of the same organisation) and no API gives the credit balance. A key saved here wins over
// ANTHROPIC_ADMIN_KEY.
import { pullAnthropicReport } from "../vendor";
import type { Connector } from "./types";
import { periodOf } from "./types";

export const anthropic: Connector = {
  vendor: "anthropic",
  label: "Anthropic",
  method: "api",
  collects: "Anthropic's own month total from the Admin API cost report (reconciliation; cost is counted per request)",
  whereToGet: "console.anthropic.com → Settings → Admin keys: create an Admin key (sk-ant-admin…). Organisation admins only.",
  credentials: [{ key: "adminKey", label: "Admin key (sk-ant-admin…)", secret: true, env: "ANTHROPIC_ADMIN_KEY" }],
  missing: (c) => (c.adminKey ? null : "Enter an Anthropic Admin key (or set ANTHROPIC_ADMIN_KEY)"),
  async collect({ now, creds, step }) {
    await step("downloading", "Reading the Admin API cost report for the month");
    const cents = await pullAnthropicReport(creds.adminKey);
    return { reported: cents === null ? null : { period: periodOf(now), cents } };
  },
};
