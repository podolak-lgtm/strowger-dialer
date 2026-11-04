"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { generateApiKey } from "@/lib/affiliates";
import { requireRole } from "@/lib/auth";

export async function createAffiliate(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const key = generateApiKey();

  const affiliate = await prisma.$transaction(async (tx) => {
    const a = await tx.affiliate.create({
      data: { tenantId: s.tenant.id, name, apiKeyHash: key.hash, apiKeyHint: key.hint },
    });
    // Every affiliate gets a list of its own to post into, unassigned to a
    // campaign until somebody puts it in one.
    const list = await tx.list.create({
      data: { tenantId: s.tenant.id, name: `${name} (posted)`, source: "POST", affiliateId: a.id },
    });
    await tx.affiliate.update({ where: { id: a.id }, data: { defaultListId: list.id } });
    await tx.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "affiliate.create", target: a.id, after: { name } } });
    return a;
  });
  // The plain key is shown once, on the next page, and never stored.
  redirect(`/affiliates/${affiliate.id}?key=${encodeURIComponent(key.plain)}`);
}

export async function rotateAffiliateKey(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const key = generateApiKey();
  await prisma.affiliate.update({ where: { id, tenantId: s.tenant.id }, data: { apiKeyHash: key.hash, apiKeyHint: key.hint } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "affiliate.rotate_key", target: id } });
  redirect(`/affiliates/${id}?key=${encodeURIComponent(key.plain)}`);
}

export async function setAffiliateActive(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const active = formData.get("active") === "true";
  await prisma.affiliate.update({ where: { id, tenantId: s.tenant.id }, data: { active } });
  revalidatePath("/affiliates");
  revalidatePath(`/affiliates/${id}`);
}

export async function saveFieldMapping(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const text = String(formData.get("mapping") ?? "");
  const mapping: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=:\s]+)\s*[=:]\s*([a-z_]+)\s*$/.exec(line);
    if (m) mapping[m[1]!] = m[2]!;
  }
  await prisma.affiliate.update({ where: { id, tenantId: s.tenant.id }, data: { fieldMapping: mapping } });
  revalidatePath(`/affiliates/${id}`);
}

export async function setDefaultList(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const listId = String(formData.get("listId"));
  const list = await prisma.list.findFirst({ where: { id: listId, tenantId: s.tenant.id, affiliateId: id } });
  if (!list) throw new Error("That list does not belong to this affiliate");
  await prisma.affiliate.update({ where: { id, tenantId: s.tenant.id }, data: { defaultListId: listId } });
  revalidatePath(`/affiliates/${id}`);
}
