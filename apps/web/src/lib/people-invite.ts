// Inviting a person: their Strowger row (with SIP credentials for anyone who
// takes calls) and, optionally, the Clerk invitation email that lets them
// create a sign-in. Used by People → Invite and Send sign-in invite
// (people/actions.ts) and the onboarding wizard's Team step. Not a server
// action: callers check the session and the roles first.
import { prisma, type Role } from "@strowger/db";
import { encryptString, randomPassword } from "@strowger/shared/secrets";
import { clerkClient } from "@clerk/nextjs/server";

export function sipUsernameFor(email: string, tenantSlug: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "agent";
  return `${tenantSlug}-${local}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The person's row. Returns the SIP password once (shown on their page), or null for roles that take no calls. */
export async function createInvitedUser(tenant: { id: string; slug: string }, input: { email: string; firstName?: string | null; lastName?: string | null; roles: Role[] }) {
  const email = input.email.trim().toLowerCase();
  const needsPhone = input.roles.some((r) => r === "AGENT" || r === "TEAM_LEADER" || r === "SUPERVISOR" || r === "ROOM_SUPERVISOR" || r === "ADMIN");
  const password = needsPhone ? randomPassword() : null;
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      roles: input.roles,
      sipUsername: needsPhone ? sipUsernameFor(email, tenant.slug) : null,
      sipSecret: password ? encryptString(password, process.env.ENGINE_INTERNAL_KEY ?? "") : null,
    },
  });
  return { user, password };
}

/** Clerk's invitation email (a link to create their sign-in). Throws when Clerk refuses. */
export async function sendClerkInvitation(email: string, redirectPath = "/sign-up"): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://strowger.crossbar.digital";
  const client = await clerkClient();
  await client.invitations.createInvitation({ emailAddress: email, redirectUrl: `${base}${redirectPath}`, ignoreExisting: true, expiresInDays: 14 });
}
