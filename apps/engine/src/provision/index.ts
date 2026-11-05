// Number provisioning from inside Strowger: set up the carrier plumbing once
// (Telnyx voice connection pointed at the jambonz SBC, a messaging profile
// with our webhook, the jambonz carrier with Telnyx's gateways), then
// search, order and register numbers in one step, and keep the three
// systems (Telnyx, jambonz, our CallerIdNumber table) in agreement.
import { prisma } from "@strowger/db";
import { stateForAreaCode } from "@strowger/shared";
import { config } from "../config";
import { log } from "../log";
import { chargeDidMonthly } from "../billing";
import { jambonzAdmin, type Carrier } from "./jambonz-admin";
import { TELNYX_SIGNALLING_IPS, TELNYX_SIP_HOST, telnyx, telnyxConfigured, type BrandInput, type CampaignInput } from "./telnyx";

const CARRIER_NAME = () => config.JAMBONZ_CARRIER || "Telnyx";
const CONNECTION_NAME = "Strowger (jambonz)";
const OUTBOUND_PROFILE_NAME = "Strowger";
const sbcFqdn = () => config.JAMBONZ_SBC_FQDN || config.JAMBONZ_SIP_REALM || "";
const smsWebhook = () => `${config.WEB_PUBLIC_URL.replace(/\/+$/, "")}/api/webhooks/sms/telnyx`;
const e164 = (phone: string) => (phone.startsWith("+") ? phone : `+1${phone}`);
const national = (e: string) => e.replace(/^\+1/, "");

export interface ProvisionStatus {
  telnyx: boolean;
  jambonz: boolean;
  sbcFqdn: string;
  smsWebhook: string;
  carrierName: string;
  connection: { id: string; name: string; fqdn: string | null } | null;
  outboundProfileId: string | null;
  messagingProfile: { id: string; name: string; webhook: string | null } | null;
  carrier: { sid: string; name: string; gateways: number } | null;
  counts: Record<string, number>;
  missing: string[];
}

export async function provisionStatus(tenantId: string): Promise<ProvisionStatus> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const missing: string[] = [];
  if (!telnyxConfigured) missing.push("TELNYX_API_KEY on the engine");
  if (!config.JAMBONZ_API_KEY) missing.push("JAMBONZ_API_KEY on the engine");
  if (!config.JAMBONZ_APPLICATION_SID) missing.push("JAMBONZ_APPLICATION_SID on the engine");
  if (!sbcFqdn()) missing.push("JAMBONZ_SBC_FQDN or JAMBONZ_SIP_REALM on the engine");

  let connection: ProvisionStatus["connection"] = null;
  let messagingProfile: ProvisionStatus["messagingProfile"] = null;
  let carrier: ProvisionStatus["carrier"] = null;
  if (telnyxConfigured && t.telnyxConnectionId) {
    try {
      const c = await telnyx.getFqdnConnection(t.telnyxConnectionId);
      const fqdns = await telnyx.listFqdns(c.id);
      connection = { id: c.id, name: c.connection_name, fqdn: fqdns[0] ? `${fqdns[0].fqdn}:${fqdns[0].port}` : null };
    } catch (e) {
      log.warn({ err: e }, "provision status: connection lookup failed");
    }
  }
  if (telnyxConfigured && t.telnyxMessagingProfileId) {
    try {
      const p = (await telnyx.listMessagingProfiles()).find((x) => x.id === t.telnyxMessagingProfileId);
      if (p) messagingProfile = { id: p.id, name: p.name, webhook: p.webhook_url };
    } catch (e) {
      log.warn({ err: e }, "provision status: messaging profile lookup failed");
    }
  }
  if (config.JAMBONZ_API_KEY && t.jambonzCarrierSid) {
    try {
      const c = (await jambonzAdmin.listCarriers()).find((x) => x.voip_carrier_sid === t.jambonzCarrierSid);
      if (c) carrier = { sid: c.voip_carrier_sid, name: c.name, gateways: (await jambonzAdmin.listGateways(c.voip_carrier_sid)).length };
    } catch (e) {
      log.warn({ err: e }, "provision status: carrier lookup failed");
    }
  }
  const grouped = await prisma.callerIdNumber.groupBy({ by: ["provisionStatus"], where: { tenantId }, _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.provisionStatus] = g._count._all;
  return {
    telnyx: telnyxConfigured,
    jambonz: Boolean(config.JAMBONZ_API_KEY),
    sbcFqdn: sbcFqdn(),
    smsWebhook: smsWebhook(),
    carrierName: CARRIER_NAME(),
    connection,
    outboundProfileId: t.telnyxOutboundProfileId,
    messagingProfile,
    carrier,
    counts,
    missing,
  };
}

/**
 * Idempotent: creates what is missing, reuses what exists by name, and records
 * the ids on the tenant. Safe to run again after a partial failure.
 */
export async function setupCarrier(tenantId: string): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!telnyxConfigured) throw new Error("TELNYX_API_KEY is not set on the engine");
  if (!config.JAMBONZ_API_KEY) throw new Error("JAMBONZ_API_KEY is not set on the engine");
  const fqdn = sbcFqdn();
  if (!fqdn) throw new Error("JAMBONZ_SBC_FQDN (or JAMBONZ_SIP_REALM) is not set on the engine");

  // 1. Outbound voice profile (billing / spend limits live here in Telnyx).
  let profileId = t.telnyxOutboundProfileId;
  if (!profileId) {
    const existing = (await telnyx.listOutboundProfiles()).find((p) => p.name === OUTBOUND_PROFILE_NAME);
    profileId = existing?.id ?? (await telnyx.createOutboundProfile(OUTBOUND_PROFILE_NAME)).id;
    steps.push(existing ? `Outbound voice profile "${OUTBOUND_PROFILE_NAME}" found` : `Outbound voice profile "${OUTBOUND_PROFILE_NAME}" created`);
  }

  // 2. FQDN connection: inbound calls go to the jambonz SBC; outbound from jambonz authenticates with credentials.
  let connectionId = t.telnyxConnectionId;
  let creds: { user_name?: string; password?: string } = {};
  if (!connectionId) {
    const existing = (await telnyx.listFqdnConnections()).find((c) => c.connection_name === CONNECTION_NAME);
    if (existing) {
      connectionId = existing.id;
      steps.push(`SIP connection "${CONNECTION_NAME}" found`);
    } else {
      const created = await telnyx.createFqdnConnection(CONNECTION_NAME, profileId);
      connectionId = created.id;
      steps.push(`SIP connection "${CONNECTION_NAME}" created`);
    }
  }
  const conn = await telnyx.getFqdnConnection(connectionId);
  creds = { user_name: conn.user_name, password: conn.password };
  const fqdns = await telnyx.listFqdns(connectionId);
  let rec = fqdns.find((f) => f.fqdn === fqdn);
  if (!rec) {
    rec = await telnyx.addFqdn(connectionId, fqdn, 5060);
    steps.push(`Inbound route ${fqdn}:5060 added`);
  }
  if (conn.inbound?.default_primary_fqdn_id !== rec.id) {
    await telnyx.setPrimaryFqdn(connectionId, rec.id);
    steps.push(`Inbound route ${fqdn} set as primary`);
  }

  // 3. Messaging profile (one per tenant: 10DLC campaigns attach to it) with our inbound webhook.
  let messagingProfileId = t.telnyxMessagingProfileId;
  const profileName = `Strowger – ${t.name}`;
  if (!messagingProfileId) {
    const existing = (await telnyx.listMessagingProfiles()).find((p) => p.name === profileName);
    if (existing) {
      messagingProfileId = existing.id;
      if (existing.webhook_url !== smsWebhook()) await telnyx.updateMessagingProfileWebhook(existing.id, smsWebhook());
      steps.push(`Messaging profile "${profileName}" found`);
    } else {
      messagingProfileId = (await telnyx.createMessagingProfile(profileName, smsWebhook())).id;
      steps.push(`Messaging profile "${profileName}" created, webhook ${smsWebhook()}`);
    }
  }

  // 4. jambonz carrier named as JAMBONZ_CARRIER, outbound gateway sip.telnyx.com with the connection's credentials, inbound gateways = Telnyx signalling IPs.
  let carrierSid = t.jambonzCarrierSid;
  let carrier: Carrier | undefined;
  const carriers = await jambonzAdmin.listCarriers();
  if (carrierSid) carrier = carriers.find((c) => c.voip_carrier_sid === carrierSid);
  if (!carrier) carrier = carriers.find((c) => c.name === CARRIER_NAME());
  if (carrier) {
    carrierSid = carrier.voip_carrier_sid;
    if (creds.user_name && carrier.register_username !== creds.user_name) {
      await jambonzAdmin.updateCarrier(carrierSid, { register_username: creds.user_name, register_password: creds.password });
      steps.push(`jambonz carrier "${carrier.name}" outbound credentials updated`);
    } else steps.push(`jambonz carrier "${carrier.name}" found`);
  } else {
    carrierSid = await jambonzAdmin.createCarrier({ name: CARRIER_NAME(), register_username: creds.user_name, register_password: creds.password });
    steps.push(`jambonz carrier "${CARRIER_NAME()}" created`);
  }
  const gateways = await jambonzAdmin.listGateways(carrierSid);
  if (!gateways.some((g) => g.outbound && g.ipv4 === TELNYX_SIP_HOST)) {
    await jambonzAdmin.createGateway({ voip_carrier_sid: carrierSid, ipv4: TELNYX_SIP_HOST, port: 5060, inbound: false, outbound: true });
    steps.push(`Outbound gateway ${TELNYX_SIP_HOST} added`);
  }
  for (const ip of TELNYX_SIGNALLING_IPS) {
    if (!gateways.some((g) => g.inbound && g.ipv4 === ip)) {
      await jambonzAdmin.createGateway({ voip_carrier_sid: carrierSid, ipv4: ip, port: 5060, inbound: true, outbound: false });
      steps.push(`Inbound gateway ${ip} added`);
    }
  }

  await prisma.tenant.update({ where: { id: tenantId }, data: { telnyxOutboundProfileId: profileId, telnyxConnectionId: connectionId, telnyxMessagingProfileId: messagingProfileId, jambonzCarrierSid: carrierSid } });
  if (steps.length === 0) steps.push("Everything was already in place");
  return { steps };
}

export async function searchNumbers(q: { areaCode?: string; state?: string; locality?: string; limit?: number }) {
  const rows = await telnyx.searchNumbers({ ...q, features: ["voice", "sms"] });
  return rows.map((r) => ({
    phone: national(r.phone_number),
    e164: r.phone_number,
    city: r.region_information?.find((x) => x.region_type === "rate_center" || x.region_type === "location")?.region_name ?? null,
    state: r.region_information?.find((x) => x.region_type === "state")?.region_name ?? null,
    monthly: r.cost_information?.monthly_cost ?? null,
    upfront: r.cost_information?.upfront_cost ?? null,
    features: (r.features ?? []).map((f) => f.name),
  }));
}

/** Buy numbers, attach them to the voice connection and messaging profile, then register them in jambonz. */
export async function orderNumbers(input: { tenantId: string; phones: string[]; campaignId: string | null; areaCode: string; requestedBy?: string }) {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: input.tenantId } });
  if (!t.telnyxConnectionId || !t.jambonzCarrierSid) throw new Error("Run carrier setup first (voice connection and jambonz carrier are missing)");
  const phones = [...new Set(input.phones.map((p) => p.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1")).filter((p) => p.length === 10))];
  if (phones.length === 0) throw new Error("No valid numbers");
  const order = await prisma.numberOrder.create({ data: { tenantId: t.id, campaignId: input.campaignId, areaCode: input.areaCode, quantity: phones.length, requestedBy: input.requestedBy } });
  let result;
  try {
    result = await telnyx.order(phones.map(e164), t.telnyxConnectionId, t.telnyxMessagingProfileId, `strowger:${t.slug}:${order.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.numberOrder.update({ where: { id: order.id }, data: { status: "error", error: msg } });
    throw e;
  }
  await prisma.numberOrder.update({ where: { id: order.id }, data: { telnyxOrderId: result.id, status: result.status } });
  for (const n of result.phone_numbers) {
    const phone = national(n.phone_number);
    await prisma.callerIdNumber.upsert({
      where: { tenantId_phone: { tenantId: t.id, phone } },
      create: { tenantId: t.id, phone, areaCode: phone.slice(0, 3), state: stateForAreaCode(phone.slice(0, 3)), provider: "telnyx", smsEnabled: Boolean(t.telnyxMessagingProfileId), campaignId: input.campaignId, provisionStatus: n.status === "failure" ? "failed" : "ordered", orderId: order.id, telnyxNumberId: n.id },
      update: { provider: "telnyx", campaignId: input.campaignId ?? undefined, provisionStatus: n.status === "failure" ? "failed" : "ordered", orderId: order.id, telnyxNumberId: n.id },
    });
  }
  await syncOrder(order.id);
  return prisma.numberOrder.findUniqueOrThrow({ where: { id: order.id }, include: { numbers: true } });
}

/** Poll one order at Telnyx and finish the numbers that came through. */
export async function syncOrder(orderId: string): Promise<void> {
  const order = await prisma.numberOrder.findUnique({ where: { id: orderId }, include: { tenant: true } });
  if (!order?.telnyxOrderId) return;
  const r = await telnyx.getOrder(order.telnyxOrderId);
  await prisma.numberOrder.update({ where: { id: orderId }, data: { status: r.status } });
  for (const n of r.phone_numbers) {
    const phone = national(n.phone_number);
    if (n.status === "failure") {
      await prisma.callerIdNumber.updateMany({ where: { tenantId: order.tenantId, phone }, data: { provisionStatus: "failed", provisionError: "Telnyx could not fulfil this number", status: "RETIRED" } });
      continue;
    }
    if (n.status !== "success") continue;
    await finishNumber(order.tenant, phone);
  }
}

/** Make sure a bought number is on the connection + profile and in jambonz. */
async function finishNumber(t: { id: string; telnyxConnectionId: string | null; telnyxMessagingProfileId: string | null; jambonzCarrierSid: string | null }, phone: string): Promise<void> {
  const row = await prisma.callerIdNumber.findUnique({ where: { tenantId_phone: { tenantId: t.id, phone } } });
  if (!row) return;
  try {
    const tn = await telnyx.findNumber(e164(phone));
    if (!tn || tn.status !== "active") {
      await prisma.callerIdNumber.update({ where: { id: row.id }, data: { provisionStatus: "ordered", provisionError: tn ? `Telnyx status: ${tn.status}` : "Not yet visible at Telnyx" } });
      return;
    }
    if (t.telnyxConnectionId && tn.connection_id !== t.telnyxConnectionId) await telnyx.setNumberConnection(tn.id, t.telnyxConnectionId);
    if (t.telnyxMessagingProfileId && tn.messaging_profile_id !== t.telnyxMessagingProfileId) await telnyx.setNumberMessagingProfile(tn.id, t.telnyxMessagingProfileId);
    let jzSid = row.jambonzPhoneNumberSid;
    if (!jzSid && t.jambonzCarrierSid) {
      const existing = (await jambonzAdmin.listNumbers()).find((n) => n.number.replace(/\D/g, "").replace(/^1/, "") === phone);
      if (existing) {
        jzSid = existing.phone_number_sid;
        if (existing.application_sid !== (config.JAMBONZ_APPLICATION_SID ?? null)) await jambonzAdmin.setNumberApplication(jzSid, config.JAMBONZ_APPLICATION_SID ?? null);
      } else jzSid = await jambonzAdmin.addNumber(e164(phone), t.jambonzCarrierSid, config.JAMBONZ_APPLICATION_SID ?? null);
    }
    await prisma.callerIdNumber.update({
      where: { id: row.id },
      data: { telnyxNumberId: tn.id, jambonzPhoneNumberSid: jzSid, provisionStatus: jzSid ? (t.telnyxMessagingProfileId ? "ready" : "voice") : "ordered", provisionError: null, smsEnabled: Boolean(t.telnyxMessagingProfileId), status: row.status === "RETIRED" ? "ACTIVE" : row.status },
    });
    if (jzSid) void chargeDidMonthly(t.id, row.id, phone).catch((e) => log.warn({ err: e }, "billing: did charge failed"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ phone, err: msg }, "provisioning number failed");
    await prisma.callerIdNumber.update({ where: { id: row.id }, data: { provisionStatus: "failed", provisionError: msg.slice(0, 300) } });
  }
}

/** Reconcile with Telnyx: adopt numbers bought elsewhere, finish pending ones, retire numbers that are gone. */
export async function syncNumbers(tenantId: string): Promise<{ adopted: number; finished: number; gone: number }> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!telnyxConfigured) throw new Error("TELNYX_API_KEY is not set on the engine");
  const atTelnyx = await telnyx.listNumbers();
  const ours = await prisma.callerIdNumber.findMany({ where: { tenantId } });
  const byPhone = new Map(ours.map((n) => [n.phone, n]));
  let adopted = 0;
  // Numbers on our connection, or unassigned, that we do not know yet.
  for (const tn of atTelnyx) {
    const phone = national(tn.phone_number);
    if (byPhone.has(phone)) continue;
    if (t.telnyxConnectionId && tn.connection_id && tn.connection_id !== t.telnyxConnectionId) continue; // belongs to another connection/tenant
    await prisma.callerIdNumber.create({ data: { tenantId, phone, areaCode: phone.slice(0, 3), state: stateForAreaCode(phone.slice(0, 3)), provider: "telnyx", telnyxNumberId: tn.id, provisionStatus: "ordered" } });
    adopted++;
  }
  let finished = 0;
  const pending = await prisma.callerIdNumber.findMany({ where: { tenantId, provisionStatus: { in: ["ordered", "voice", "failed"] }, status: { not: "RETIRED" } } });
  for (const n of pending) {
    await finishNumber(t, n.phone);
    finished++;
  }
  // Manual numbers that are in fact at Telnyx: link them too.
  for (const n of ours.filter((x) => x.provisionStatus === "manual")) {
    if (atTelnyx.some((tn) => national(tn.phone_number) === n.phone)) {
      await prisma.callerIdNumber.update({ where: { id: n.id }, data: { provisionStatus: "ordered", provider: "telnyx" } });
      await finishNumber(t, n.phone);
      finished++;
    }
  }
  let gone = 0;
  for (const n of ours.filter((x) => x.telnyxNumberId && x.status !== "RETIRED")) {
    if (!atTelnyx.some((tn) => tn.id === n.telnyxNumberId)) {
      await prisma.callerIdNumber.update({ where: { id: n.id }, data: { status: "RETIRED", provisionError: "No longer on the Telnyx account" } });
      gone++;
    }
  }
  for (const o of await prisma.numberOrder.findMany({ where: { tenantId, status: "pending" } })) await syncOrder(o.id).catch((e) => log.warn({ err: e, orderId: o.id }, "order sync failed"));
  return { adopted, finished, gone };
}

/** Give a number back to Telnyx and remove it from jambonz. */
export async function releaseNumber(tenantId: string, id: string): Promise<void> {
  const n = await prisma.callerIdNumber.findFirst({ where: { id, tenantId } });
  if (!n) throw new Error("Unknown number");
  if (n.jambonzPhoneNumberSid) await jambonzAdmin.deleteNumber(n.jambonzPhoneNumberSid).catch((e) => log.warn({ err: e }, "jambonz delete failed"));
  if (n.telnyxNumberId) await telnyx.releaseNumber(n.telnyxNumberId);
  await prisma.callerIdNumber.update({ where: { id }, data: { status: "RETIRED", provisionStatus: "released", jambonzPhoneNumberSid: null, campaignId: null } });
}

/** Pending orders across tenants: the scheduler calls this. */
export async function syncPendingOrders(): Promise<void> {
  if (!telnyxConfigured) return;
  const orders = await prisma.numberOrder.findMany({ where: { status: "pending", telnyxOrderId: { not: null } }, take: 50 });
  for (const o of orders) await syncOrder(o.id).catch((e) => log.warn({ err: e, orderId: o.id }, "order sync failed"));
}

// ---- 10DLC

export async function tenDlcStatus(tenantId: string) {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  let brand = t.tenDlcBrand as Record<string, unknown> | null;
  let campaign = t.tenDlcCampaign as Record<string, unknown> | null;
  if (telnyxConfigured) {
    try {
      if (t.tenDlcBrandId) brand = (await telnyx.getBrand(t.tenDlcBrandId)) as unknown as Record<string, unknown>;
      if (t.tenDlcCampaignId) campaign = (await telnyx.getCampaign(t.tenDlcCampaignId)) as unknown as Record<string, unknown>;
      await prisma.tenant.update({ where: { id: tenantId }, data: { tenDlcBrand: (brand as object | null) ?? undefined, tenDlcCampaign: (campaign as object | null) ?? undefined } });
    } catch (e) {
      log.warn({ err: e }, "10dlc refresh failed");
    }
  }
  let numbersAssigned: number | null = null;
  if (campaign && typeof campaign.assignedPhoneNumbersCount === "number") numbersAssigned = campaign.assignedPhoneNumbersCount;
  return { brandId: t.tenDlcBrandId, campaignId: t.tenDlcCampaignId, messagingProfileId: t.telnyxMessagingProfileId, brand, campaign, numbersAssigned };
}

export async function createBrand(tenantId: string, input: BrandInput) {
  const b = await telnyx.createBrand(input);
  await prisma.tenant.update({ where: { id: tenantId }, data: { tenDlcBrandId: b.brandId, tenDlcBrand: b as unknown as object } });
  return b;
}

export async function createTenDlcCampaign(tenantId: string, input: Omit<CampaignInput, "brandId">) {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!t.tenDlcBrandId) throw new Error("Register the brand first");
  const c = await telnyx.createCampaign({ ...input, brandId: t.tenDlcBrandId });
  await prisma.tenant.update({ where: { id: tenantId }, data: { tenDlcCampaignId: c.campaignId, tenDlcCampaign: c as unknown as object } });
  return c;
}

/** Attach every number on the tenant's messaging profile to the approved campaign. */
export async function assignNumbersToCampaign(tenantId: string): Promise<{ taskId: string }> {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!t.telnyxMessagingProfileId) throw new Error("Run carrier setup first (no messaging profile)");
  if (!t.tenDlcCampaignId) throw new Error("No 10DLC campaign yet");
  return telnyx.assignProfileToCampaign(t.telnyxMessagingProfileId, t.tenDlcCampaignId);
}

export async function usecaseFees(tenantId: string, usecase: string) {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!t.tenDlcBrandId) return null;
  return telnyx.usecaseQualification(t.tenDlcBrandId, usecase);
}
