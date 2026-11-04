// Outbound webhooks to CRMs. A disposition (or sale, callback, dnc) queues a
// delivery per matching endpoint; the scheduler sends them with an HMAC
// signature and backs off on failure.
import { createHmac } from "node:crypto";
import { prisma } from "@strowger/db";
import { log } from "../log";

export type WebhookEvent = "disposition" | "sale" | "callback" | "dnc" | "call.ended";

export async function enqueueWebhooks(tenantId: string, campaignId: string | null, events: WebhookEvent[], payload: Record<string, unknown>): Promise<number> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { tenantId, active: true, OR: [{ campaignId: null }, ...(campaignId ? [{ campaignId }] : [])] },
  });
  let n = 0;
  for (const ep of endpoints) {
    const hit = events.find((e) => ep.events.includes(e));
    if (!hit) continue;
    await prisma.webhookDelivery.create({ data: { endpointId: ep.id, event: hit, payload: payload as never } });
    n++;
  }
  return n;
}

function backoffMs(attempt: number): number {
  return Math.min(6 * 3600_000, 30_000 * 2 ** attempt); // 30s, 1m, 2m, … up to 6h
}

export async function deliverPending(limit = 50): Promise<{ sent: number; failed: number }> {
  const now = new Date();
  const pending = await prisma.webhookDelivery.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { endpoint: true },
  });
  let sent = 0;
  let failed = 0;
  for (const d of pending) {
    // Respect backoff: createdAt + sum of previous waits approximated by last attempt time.
    const due = d.attempts === 0 ? d.createdAt : new Date((d.deliveredAt ?? d.createdAt).getTime() + backoffMs(d.attempts - 1));
    if (due > now) continue;
    const body = JSON.stringify({ id: d.id, event: d.event, created_at: d.createdAt.toISOString(), data: d.payload });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", d.endpoint.secret).update(`${ts}.${body}`).digest("hex");
    try {
      const res = await fetch(d.endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Strowger-Webhooks/1", "x-strowger-event": d.event, "x-strowger-signature": `t=${ts},v1=${sig}` },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "DELIVERED", attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null } });
        sent++;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      const attempts = d.attempts + 1;
      const giveUp = attempts >= 10;
      await prisma.webhookDelivery.update({
        where: { id: d.id },
        data: { attempts, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 300), status: giveUp ? "FAILED" : "PENDING", deliveredAt: new Date() /* last attempt time, for backoff */ },
      });
      failed++;
      if (giveUp) log.warn({ deliveryId: d.id, url: d.endpoint.url }, "webhook delivery abandoned after 10 attempts");
    }
  }
  return { sent, failed };
}
