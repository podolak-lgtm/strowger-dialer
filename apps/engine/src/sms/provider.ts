// Outbound SMS behind one interface. Commio first (same numbers as voice),
// Telnyx as the alternative, and a log-only provider when neither is set so
// cadences can be exercised without a carrier.
import { activeTrial, chargeSms } from "../billing";
import { prisma } from "@strowger/db";
import { config } from "../config";
import { log } from "../log";

export interface SmsResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  name: string;
  send(from: string, to: string, body: string): Promise<SmsResult>;
}

const logOnly: SmsProvider = {
  name: "log",
  async send(from, to, body) {
    log.info({ from, to, body }, "SMS (log-only provider)");
    return { ok: true, providerMessageId: `log-${Date.now()}` };
  },
};

/** Commio (thinQ) origination SMS API. */
const commio: SmsProvider = {
  name: "commio",
  async send(from, to, body) {
    const auth = Buffer.from(`${config.COMMIO_USERNAME}:${config.COMMIO_TOKEN}`).toString("base64");
    const res = await fetch(`${config.COMMIO_API_URL}/account/${config.COMMIO_ACCOUNT_ID}/product/origination/sms/send`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ from_did: from, to_did: to, message: body }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `commio ${res.status}: ${text.slice(0, 200)}` };
    let id: string | undefined;
    try {
      id = String((JSON.parse(text) as { guid?: string; id?: string }).guid ?? (JSON.parse(text) as { id?: string }).id ?? "");
    } catch {
      /* keep undefined */
    }
    return { ok: true, providerMessageId: id || undefined };
  },
};

const telnyx: SmsProvider = {
  name: "telnyx",
  async send(from, to, body) {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${config.TELNYX_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `+1${from}`, to: `+1${to}`, text: body }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `telnyx ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, providerMessageId: (JSON.parse(text) as { data?: { id?: string } }).data?.id };
    } catch {
      return { ok: true };
    }
  },
};

export function smsProvider(): SmsProvider {
  switch (config.SMS_PROVIDER) {
    case "commio":
      return config.COMMIO_ACCOUNT_ID && config.COMMIO_USERNAME && config.COMMIO_TOKEN ? commio : logOnly;
    case "telnyx":
      return config.TELNYX_API_KEY ? telnyx : logOnly;
    default:
      return logOnly;
  }
}

/** Send and record. `from` and `to` are ten digits. */
export async function sendSms(input: { tenantId: string; campaignId: string | null; leadId: string | null; agentId?: string | null; from: string; to: string; body: string; purpose: string | null }): Promise<SmsResult> {
  // Workspace kill switch (owner, 5 Nov: no texting on the first test day). Opt-out confirmations still go out: carriers require them.
  if (input.purpose !== "stop_confirm" && input.purpose !== "help_reply") {
    const t = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { settings: true } });
    if (((t?.settings ?? {}) as { textingEnabled?: boolean }).textingEnabled === false) {
      await prisma.message.create({ data: { tenantId: input.tenantId, campaignId: input.campaignId, leadId: input.leadId, agentId: input.agentId ?? null, direction: "OUTBOUND", fromPhone: input.from, toPhone: input.to, body: input.body, provider: "off", purpose: input.purpose, status: "FAILED", error: "Texting is switched off in Settings" } });
      return { ok: false, error: "Texting is switched off in Settings" };
    }
    // Free trial: no texting (texts would go out under the platform's own 10DLC registration).
    if (await activeTrial(input.tenantId)) {
      const error = "Texting is off during the free trial. It opens once a prepayment is recorded and your own texting registration is in place.";
      await prisma.message.create({ data: { tenantId: input.tenantId, campaignId: input.campaignId, leadId: input.leadId, agentId: input.agentId ?? null, direction: "OUTBOUND", fromPhone: input.from, toPhone: input.to, body: input.body, provider: "off", purpose: input.purpose, status: "FAILED", error } });
      return { ok: false, error };
    }
  }
  const p = smsProvider();
  const row = await prisma.message.create({
    data: { tenantId: input.tenantId, campaignId: input.campaignId, leadId: input.leadId, agentId: input.agentId ?? null, direction: "OUTBOUND", fromPhone: input.from, toPhone: input.to, body: input.body, provider: p.name, purpose: input.purpose, status: "QUEUED" },
  });
  let r: SmsResult;
  try {
    r = await p.send(input.from, input.to, input.body);
  } catch (e) {
    r = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await prisma.message.update({
    where: { id: row.id },
    data: { status: r.ok ? "SENT" : "FAILED", providerMessageId: r.providerMessageId ?? null, error: r.error ?? null },
  });
  if (r.ok) void chargeSms(input.tenantId, row.id).catch(() => undefined);
  if (input.leadId) {
    await prisma.leadEvent.create({ data: { tenantId: input.tenantId, leadId: input.leadId, kind: "TEXT_OUT", data: { purpose: input.purpose, ok: r.ok, error: r.error ?? null, provider: p.name } } });
  }
  return r;
}
