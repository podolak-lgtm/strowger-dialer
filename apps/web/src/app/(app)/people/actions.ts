"use server";

import { prisma, type AgentMode, type Role } from "@strowger/db";
import { encryptString, randomPassword } from "@strowger/shared/secrets";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { clerkClient } from "@clerk/nextjs/server";

const ROLE_VALUES: Role[] = ["ADMIN", "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER", "AGENT", "AFFILIATE"];

function rolesFrom(formData: FormData): Role[] {
  const picked = formData.getAll("roles").map(String).filter((r): r is Role => (ROLE_VALUES as string[]).includes(r));
  return picked.length ? picked : ["AGENT"];
}

function sipUsernameFor(email: string, tenantSlug: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "agent";
  return `${tenantSlug}-${local}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function invitePerson(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const firstName = String(formData.get("firstName") ?? "").trim() || null;
  const lastName = String(formData.get("lastName") ?? "").trim() || null;
  if (!email.includes("@")) throw new Error("A valid email is required");
  const roles = rolesFrom(formData);
  // Only an admin may make another admin.
  if (roles.includes("ADMIN") && !s.roles.includes("ADMIN")) throw new Error("Only an admin can grant admin");

  const needsPhone = roles.some((r) => r === "AGENT" || r === "TEAM_LEADER" || r === "SUPERVISOR" || r === "ROOM_SUPERVISOR" || r === "ADMIN");
  const password = needsPhone ? randomPassword() : null;
  const user = await prisma.user.create({
    data: {
      tenantId: s.tenant.id,
      email,
      firstName,
      lastName,
      roles,
      sipUsername: needsPhone ? sipUsernameFor(email, s.tenant.slug) : null,
      sipSecret: password ? encryptString(password, process.env.ENGINE_INTERNAL_KEY ?? "") : null,
    },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.invite", target: user.id, after: { email, roles } } });
  redirect(`/people/${user.id}${password ? `?sip=${encodeURIComponent(password)}` : ""}`);
}

export async function updatePerson(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const target = await prisma.user.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!target) throw new Error("Unknown person");
  const roles = rolesFrom(formData);
  if ((roles.includes("ADMIN") || target.roles.includes("ADMIN")) && !s.roles.includes("ADMIN")) throw new Error("Only an admin can change an admin");
  const active = formData.get("active") === "on";
  if (target.id === s.user.id && (!active || !roles.includes("ADMIN")) && s.roles.includes("ADMIN")) throw new Error("You cannot remove your own admin access");
  await prisma.user.update({
    where: { id },
    data: {
      roles,
      active,
      firstName: String(formData.get("firstName") ?? "").trim() || null,
      lastName: String(formData.get("lastName") ?? "").trim() || null,
      level: Math.max(1, Math.min(8, Number(formData.get("level")) || target.level)),
      mobilePhone: String(formData.get("mobilePhone") ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1") || null,
    },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.update", target: id, before: { roles: target.roles, active: target.active }, after: { roles, active } } });
  revalidatePath(`/people/${id}`);
  revalidatePath("/people");
}

export async function resetSipPassword(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const target = await prisma.user.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!target) throw new Error("Unknown person");
  const password = randomPassword();
  await prisma.user.update({
    where: { id },
    data: {
      sipUsername: target.sipUsername ?? sipUsernameFor(target.email, s.tenant.slug),
      sipSecret: encryptString(password, process.env.ENGINE_INTERNAL_KEY ?? ""),
    },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.sip_reset", target: id } });
  redirect(`/people/${id}?sip=${encodeURIComponent(password)}`);
}

export async function setUserAffiliate(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const affiliateId = String(formData.get("affiliateId") ?? "") || null;
  if (affiliateId) {
    const a = await prisma.affiliate.findFirst({ where: { id: affiliateId, tenantId: s.tenant.id }, select: { id: true } });
    if (!a) throw new Error("Unknown affiliate");
  }
  await prisma.user.updateMany({ where: { id, tenantId: s.tenant.id }, data: { affiliateId } });
  revalidatePath(`/people/${id}`);
}

export async function setCampaignAssignment(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const userId = String(formData.get("id"));
  const campaignId = String(formData.get("campaignId"));
  const mode = String(formData.get("agentMode") ?? "BOTH") as AgentMode | "NONE";
  const [user, campaign] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, tenantId: s.tenant.id } }),
    prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id } }),
  ]);
  if (!user || !campaign) throw new Error("Unknown person or campaign");
  if (mode === "NONE") {
    await prisma.campaignAgent.deleteMany({ where: { campaignId, userId } });
  } else {
    await prisma.campaignAgent.upsert({
      where: { campaignId_userId: { campaignId, userId } },
      create: { tenantId: s.tenant.id, campaignId, userId, agentMode: mode },
      update: { agentMode: mode },
    });
  }
  revalidatePath(`/people/${userId}`);
}

/**
 * Email a Clerk invitation so the person can create their sign-in. Without it
 * the sign-in form says "Couldn't find your account": a Strowger person row is
 * not a login until they sign up with that exact email.
 */
export async function sendSignInInvite(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const target = await prisma.user.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!target) throw new Error("Unknown person");
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://strowger.crossbar.digital";
  let msg: string;
  try {
    const client = await clerkClient();
    await client.invitations.createInvitation({ emailAddress: target.email, redirectUrl: `${base}/sign-up`, ignoreExisting: true, expiresInDays: 14 });
    msg = `Invitation emailed to ${target.email}. The link lets them create their sign-in; they then land on their agent screen.`;
    await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.invite.email", target: id } });
  } catch (e) {
    msg = `Could not email the invitation: ${e instanceof Error ? e.message : String(e)}. They can still use "Sign up" on the sign-in page with ${target.email}.`;
  }
  redirect(`/people/${id}?msg=${encodeURIComponent(msg)}`);
}
