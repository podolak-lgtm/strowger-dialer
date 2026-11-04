"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@strowger/db";
import { redirect } from "next/navigation";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "workspace";
}

export async function createTenant(formData: FormData) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) redirect("/sign-in");
  const clerk = await currentUser();
  const email = clerk?.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!email) throw new Error("Your account has no email address");

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) throw new Error("Company name is required");

  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) redirect("/dashboard");

  let slug = slugify(name);
  for (let n = 2; await prisma.tenant.findUnique({ where: { slug } }); n++) slug = `${slugify(name)}-${n}`;

  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name, slug } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        clerkUserId,
        email,
        firstName: clerk?.firstName ?? null,
        lastName: clerk?.lastName ?? null,
        roles: ["ADMIN"],
      },
    });
    await tx.auditLog.create({
      data: { tenantId: tenant.id, actorId: user.id, action: "tenant.create", target: tenant.id, after: { name, slug } },
    });
  });
  redirect("/dashboard");
}
