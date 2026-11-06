// A vendor's one-time sign-in code, read from Crossbar's inbox (the same
// GET /api/agent/inbox the Free Caller Registry automation uses). Works only
// for an address at our domain that Crossbar receives mail for: the owner sets
// the vendor account's email (or a forwarding rule) to that address.
import { extractEmailCode } from "@strowger/shared/vendor-collect";
import { config } from "../../config";

export const inboxConfigured = Boolean(config.CROSSBAR_URL && config.CROSSBAR_AGENT_KEY);

/** Wait for an email to `to` received after `since` whose sender or subject matches `from`, and return its code. */
export async function waitForEmailCode(to: string, since: Date, from: RegExp, timeoutMs = 3 * 60_000): Promise<string> {
  if (!inboxConfigured) throw new Error("CROSSBAR_URL / CROSSBAR_AGENT_KEY are not set, so the sign-in email cannot be read");
  const url = new URL("/api/agent/inbox", config.CROSSBAR_URL);
  url.searchParams.set("to", to.toLowerCase());
  url.searchParams.set("since", new Date(since.getTime() - 30_000).toISOString());
  url.searchParams.set("limit", "10");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.CROSSBAR_AGENT_KEY}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Crossbar inbox: ${res.status} ${(await res.text()).slice(0, 120)}`);
    const { emails } = (await res.json()) as { emails: { from: string; subject: string; text: string; receivedAt: string }[] };
    // Newest first, so a stale code from an earlier attempt is not used.
    for (const e of [...emails].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))) {
      if (new Date(e.receivedAt).getTime() < since.getTime() - 30_000) continue;
      if (!from.test(`${e.from}\n${e.subject}`)) continue;
      const code = extractEmailCode(`${e.subject}\n${e.text}`);
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`No sign-in email reached ${to} within ${Math.round(timeoutMs / 60_000)} minutes`);
}
