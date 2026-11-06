// The workspace's switched-on test phones (shared/compliance/test-phones.ts),
// read from Tenant.settings with a 15 s cache: the hopper asks per lead.
import { prisma } from "@strowger/db";
import { testPhoneActive } from "@strowger/shared/compliance";

const cache = new Map<string, { at: number; settings: unknown }>();

export async function isTestPhone(tenantId: string, phone: string, now = new Date()): Promise<boolean> {
  let hit = cache.get(tenantId);
  if (!hit || now.getTime() - hit.at > 15_000) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    hit = { at: now.getTime(), settings: t?.settings ?? null };
    cache.set(tenantId, hit);
  }
  return testPhoneActive(hit.settings, phone, now);
}
