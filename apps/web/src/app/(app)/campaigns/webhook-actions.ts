"use server";

import { randomBytes } from "node:crypto";
import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

const EVENTS = ["disposition", "sale", "callback", "dnc"] as const;

export async function addWebhook(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId") ?? "") || null;
  const url = String(formData.get("url") ?? "").trim();
  if (!/^https:\/\//.test(url)) throw new Error("Webhook URL must be https");
  if (campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
    if (!c) throw new Error("Unknown campaign");
  }
  const events = formData.getAll("events").map(String).filter((e): e is (typeof EVENTS)[number] => (EVENTS as readonly string[]).includes(e));
  await prisma.webhookEndpoint.create({ data: { tenantId: s.tenant.id, campaignId, url, secret: `whsec_${randomBytes(24).toString("base64url")}`, events: events.length ? events : ["disposition"] } });
  revalidatePath(campaignId ? `/campaigns/${campaignId}` : "/campaigns");
}

export async function toggleWebhook(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!ep) return;
  await prisma.webhookEndpoint.update({ where: { id }, data: { active: !ep.active } });
  revalidatePath(ep.campaignId ? `/campaigns/${ep.campaignId}` : "/campaigns");
}

export async function deleteWebhook(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!ep) return;
  await prisma.webhookEndpoint.delete({ where: { id } });
  revalidatePath(ep.campaignId ? `/campaigns/${ep.campaignId}` : "/campaigns");
}

/** Queue a sample delivery so the receiver can be checked without a real call. */
export async function testWebhook(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!ep) return;
  await prisma.webhookDelivery.create({
    data: {
      endpointId: ep.id,
      event: "disposition",
      payload: { test: true, call: { id: "test", phone: "3055550100", outcome: "BRIDGED" }, disposition: { code: "SALE", label: "Sale", is_sale: true }, lead: { first_name: "Test", last_name: "Lead", phone: "3055550100" }, campaign: { id: ep.campaignId, name: "Test" } },
    },
  });
  const { engine } = await import("@/lib/engine");
  await engine("/webhooks/deliver", { method: "POST", body: "{}" }).catch(() => undefined);
  revalidatePath(ep.campaignId ? `/campaigns/${ep.campaignId}` : "/campaigns");
}
