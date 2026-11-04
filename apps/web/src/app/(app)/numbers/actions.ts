"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

const back = (msg: string, kind: "ok" | "error" = "ok", campaign?: string | null): never => {
  const u = new URLSearchParams({ msg, kind });
  if (campaign) u.set("campaign", campaign);
  redirect(`/numbers?${u.toString()}`);
};
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  // engine errors look like: engine /provision/x: 400 {"error":"..."}
  const j = m.match(/\{"error":"(.*)"\}$/);
  return j ? j[1].replace(/\\"/g, '"') : m;
};

export async function runSetup() {
  const s = await requireRole("SUPERVISOR");
  try {
    const r = await engine<{ steps: string[] }>("/provision/setup", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) });
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.setup", after: { steps: r.steps } } });
    back(r.steps.join(" · "));
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}

export async function orderSelected(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const phones = formData.getAll("phones").map(String);
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  const areaCode = String(formData.get("areaCode") ?? "");
  if (phones.length === 0) back("Pick at least one number", "error", campaignId);
  try {
    const r = await engine<{ id: string; status: string; numbers: { phone: string; provisionStatus: string }[] }>("/provision/order", {
      method: "POST",
      body: JSON.stringify({ tenantId: s.tenant.id, phones, campaignId, areaCode, requestedBy: s.user.email }),
    });
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.order", target: r.id, after: { phones, campaignId } } });
    const ready = r.numbers.filter((n) => n.provisionStatus === "ready" || n.provisionStatus === "voice").length;
    revalidatePath("/dids");
    back(`Order ${r.status}: ${r.numbers.length} number(s) bought, ${ready} already registered in jambonz; the rest finish on the next sync (every 3 min).`, "ok", campaignId);
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error", campaignId);
  }
}

export async function syncNow() {
  const s = await requireRole("SUPERVISOR");
  try {
    const r = await engine<{ adopted: number; finished: number; gone: number }>("/provision/sync", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) });
    revalidatePath("/dids");
    back(`Synced with Telnyx: ${r.adopted} adopted, ${r.finished} checked, ${r.gone} no longer on the account.`);
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}

export async function releaseOne(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  try {
    await engine("/provision/release", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, id }) });
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.release", target: id } });
    revalidatePath("/dids");
    back("Number released back to Telnyx.");
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}

export async function assignCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  await prisma.callerIdNumber.updateMany({ where: { id, tenantId: s.tenant.id }, data: { campaignId } });
  revalidatePath("/numbers");
  revalidatePath("/dids");
}

export async function registerBrand(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const brand = {
    entityType: f("entityType"),
    displayName: f("displayName"),
    companyName: f("companyName") || undefined,
    firstName: f("firstName") || undefined,
    lastName: f("lastName") || undefined,
    ein: f("ein") || undefined,
    phone: f("phone") || undefined,
    street: f("street") || undefined,
    city: f("city") || undefined,
    state: f("state") || undefined,
    postalCode: f("postalCode") || undefined,
    country: "US",
    email: f("email"),
    website: f("website") || undefined,
    vertical: f("vertical"),
    businessContactEmail: f("businessContactEmail") || f("email"),
  };
  try {
    await engine("/provision/tendlc/brand", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, brand }) });
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.brand", after: { displayName: brand.displayName } } });
    back("Brand submitted to The Campaign Registry. Verification usually takes minutes to a day; refresh this page to see the status.");
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}

export async function registerCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const on = (k: string) => formData.get(k) === "on";
  const campaign = {
    usecase: f("usecase"),
    description: f("description"),
    messageFlow: f("messageFlow"),
    sample1: f("sample1"),
    sample2: f("sample2") || undefined,
    sample3: f("sample3") || undefined,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    optinKeywords: "START,YES,UNSTOP",
    optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT",
    helpKeywords: "HELP,INFO",
    optinMessage: f("optinMessage") || `${s.tenant.name}: You are opted in to calls and texts. Reply STOP to opt out, HELP for help. Msg & data rates may apply.`,
    optoutMessage: f("optoutMessage") || `${s.tenant.name}: You are unsubscribed and will receive no more messages.`,
    helpMessage: f("helpMessage") || `${s.tenant.name}: Reply STOP to opt out. Msg & data rates may apply.`,
    embeddedLink: on("embeddedLink"),
    embeddedPhone: on("embeddedPhone"),
    numberPool: on("numberPool"),
    ageGated: false,
    directLending: on("directLending"),
    autoRenewal: true,
    termsAndConditions: true,
    privacyPolicyLink: f("privacyPolicyLink") || undefined,
    termsAndConditionsLink: f("termsAndConditionsLink") || undefined,
    embeddedLinkSample: f("embeddedLinkSample") || undefined,
  };
  try {
    await engine("/provision/tendlc/campaign", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, campaign }) });
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "provision.tendlc", after: { usecase: campaign.usecase } } });
    back("Campaign submitted. Carrier (MNO) review takes a few days; the status updates here. Assign numbers once it shows MNO_PROVISIONED or TELNYX_ACCEPTED.");
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}

export async function assignNumbersToTenDlc() {
  const s = await requireRole("SUPERVISOR");
  try {
    const r = await engine<{ taskId: string }>("/provision/tendlc/assign", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id }) });
    back(`Assignment started (task ${r.taskId}). Every number on the messaging profile joins the campaign over the next few minutes.`);
  } catch (e) {
    unstable_rethrow(e);
    back(errText(e), "error");
  }
}
