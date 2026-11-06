// Email to a workspace's admins, sent through Crossbar's agent API
// (POST {CROSSBAR_URL}/api/agent/email, the same key as the scrub). Crossbar
// sends from a fixed "Strowger <strowger@…>" address on its verified domain.
//
// Never throws and never blocks the caller: billing and trial jobs carry on if
// email is down. Each kind of message is sent at most once per key (Redis), so
// a re-run job or a balance that bounces around the threshold does not spam.
import { prisma } from "@strowger/db";
import { config } from "../config";
import { log } from "../log";
import { redis } from "../redis";

export const emailConfigured = Boolean(config.CROSSBAR_URL && config.CROSSBAR_AGENT_KEY);

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const site = () => config.WEB_PUBLIC_URL.replace(/\/+$/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The admins of a workspace (supervisors when it has no admin), active only. */
async function recipients(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { tenantId, active: true, roles: { hasSome: ["ADMIN", "SUPERVISOR"] } }, select: { email: true, roles: true } });
  const admins = users.filter((u) => u.roles.includes("ADMIN")).map((u) => u.email);
  return (admins.length ? admins : users.map((u) => u.email)).filter((e) => /@/.test(e)).slice(0, 10);
}

/** A plain, readable layout: a heading, paragraphs, one button. */
function layout(title: string, paragraphs: string[], button?: { label: string; path: string }): { html: string; text: string } {
  const btn = button ? `<p style="margin:24px 0"><a href="${site()}${button.path}" style="background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${esc(button.label)}</a></p>` : "";
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
<div style="height:4px;background:linear-gradient(90deg,#c026d3,#0ea5e9)"></div>
<h2 style="margin:20px 0 12px">${esc(title)}</h2>
${paragraphs.map((p) => `<p style="line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join("\n")}
${btn}
<p style="color:#64748b;font-size:12px;margin-top:28px">Strowger · ${esc(site().replace(/^https?:\/\//, ""))}</p>
</div>`;
  const text = [title, "", ...paragraphs, ...(button ? ["", `${button.label}: ${site()}${button.path}`] : [])].join("\n");
  return { html, text };
}

/** Send once per `onceKey` (kept for `ttlSeconds`). Returns whether it was sent. */
export async function emailWorkspace(tenantId: string, msg: { subject: string; title: string; paragraphs: string[]; button?: { label: string; path: string } }, onceKey: string, ttlSeconds = 400 * 86_400): Promise<boolean> {
  if (!emailConfigured) return false;
  try {
    const claimed = await redis.set(`mail:${onceKey}`, "1", "EX", ttlSeconds, "NX");
    if (!claimed) return false;
    const to = await recipients(tenantId);
    if (!to.length) return false;
    const { html, text } = layout(msg.title, msg.paragraphs, msg.button);
    const res = await fetch(new URL("/api/agent/email", config.CROSSBAR_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${config.CROSSBAR_AGENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ to, subject: msg.subject, html, text }),
    });
    if (!res.ok) {
      // Let a later run try again.
      await redis.del(`mail:${onceKey}`);
      log.warn({ tenantId, status: res.status, body: (await res.text()).slice(0, 300) }, "email: Crossbar refused");
      return false;
    }
    await prisma.auditLog.create({ data: { tenantId, action: "email.sent", target: onceKey, after: { subject: msg.subject, to: to.length } } }).catch(() => undefined);
    return true;
  } catch (e) {
    await redis.del(`mail:${onceKey}`).catch(() => undefined);
    log.warn({ err: e, tenantId }, "email: send failed");
    return false;
  }
}

// ───────────────────────── The messages ─────────────────────────

export function trialReminderEmail(tenantId: string, endsAt: Date, allowanceLeftCents: number | null) {
  const when = endsAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });
  return emailWorkspace(
    tenantId,
    {
      subject: "Your Strowger trial ends soon",
      title: "Your free trial ends soon",
      paragraphs: [
        `Your Strowger trial ends on ${when}.${allowanceLeftCents != null ? ` You have ${money(Math.max(0, allowanceLeftCents))} of free usage left.` : ""}`,
        "To keep dialing without a break, add a prepayment before then. Your campaigns, lists and numbers stay exactly as they are.",
      ],
      button: { label: "Add a prepayment", path: "/billing" },
    },
    `trial-reminder:${tenantId}`,
  );
}

export function trialEndedEmail(tenantId: string) {
  return emailWorkspace(
    tenantId,
    {
      subject: "Your Strowger trial has ended",
      title: "Your free trial has ended",
      paragraphs: ["Dialing is paused until you add a prepayment. Nothing has been deleted: your campaigns, lists, leads and numbers are waiting.", "Add a prepayment and you can pick up right where you left off."],
      button: { label: "Add a prepayment", path: "/billing" },
    },
    `trial-ended:${tenantId}`,
  );
}

export function lowBalanceEmail(tenantId: string, balanceCents: number, thresholdCents: number) {
  const day = new Date().toISOString().slice(0, 10);
  return emailWorkspace(
    tenantId,
    {
      subject: `Strowger balance is low: ${money(balanceCents)}`,
      title: "Your prepaid balance is running low",
      paragraphs: [`Your balance is ${money(balanceCents)}, below your ${money(thresholdCents)} warning level.`, "When it reaches zero, outbound dialing pauses after your grace period. Add a prepayment to keep your agents dialing."],
      button: { label: "Add a prepayment", path: "/billing" },
    },
    `low-balance:${tenantId}:${day}`,
    2 * 86_400,
  );
}

export function suspendedEmail(tenantId: string) {
  const day = new Date().toISOString().slice(0, 10);
  return emailWorkspace(
    tenantId,
    {
      subject: "Strowger outbound dialing is paused",
      title: "Outbound dialing is paused",
      paragraphs: ["Your prepaid balance has been used up and the grace period has passed, so outbound dialing is paused.", "Add a prepayment and dialing resumes straight away. Nothing has been deleted."],
      button: { label: "Add a prepayment", path: "/billing" },
    },
    `suspended:${tenantId}:${day}`,
    2 * 86_400,
  );
}

export function referralStatementEmail(tenantId: string, period: string, creditCents: number, clawbackCents: number, lines: string[]) {
  const net = creditCents - clawbackCents;
  return emailWorkspace(
    tenantId,
    {
      subject: `Strowger referral credits for ${period}: ${money(net)}`,
      title: `Your referral credits for ${period}`,
      paragraphs: [
        net > 0 ? `${money(net)} has been added to your Strowger balance as account credit.` : "No referral credit was earned this month.",
        ...lines,
        "Referral credits are account credit only: they pay for your usage and are never paid out in cash.",
      ],
      button: { label: "See Refer & earn", path: "/refer" },
    },
    `referral-statement:${tenantId}:${period}`,
  );
}
