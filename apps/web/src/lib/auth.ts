// Who is signed in, which tenant they belong to, and what they may do.
//
// Clerk authenticates. Strowger's own User row (tenant + roles) is the
// authority for authorisation. A Clerk user with no Strowger row is sent to
// onboarding, where they either create a tenant (becoming its ADMIN) or are
// matched to an invited row by email.
import { prisma, type Role, type Tenant, type User } from "@strowger/db";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cache } from "react";

export interface Session {
  user: User;
  tenant: Tenant;
  roles: Role[];
}

/** The Strowger session for the signed-in Clerk user, or null when they have no row yet. */
export const getSession = cache(async (): Promise<Session | null> => {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  let user = await prisma.user.findUnique({ where: { clerkUserId }, include: { tenant: true } });
  if (!user) {
    // First sign-in: match an invited row by email and claim it.
    const clerk = await currentUser();
    const email = clerk?.primaryEmailAddress?.emailAddress?.toLowerCase();
    if (!email) return null;
    const invited = await prisma.user.findFirst({ where: { email, clerkUserId: null, active: true } });
    if (!invited) return null;
    user = await prisma.user.update({
      where: { id: invited.id },
      data: {
        clerkUserId,
        firstName: invited.firstName ?? clerk?.firstName ?? null,
        lastName: invited.lastName ?? clerk?.lastName ?? null,
      },
      include: { tenant: true },
    });
  }
  if (!user.active) return null;
  return { user, tenant: user.tenant, roles: user.roles };
});

/** Requires a session; sends a signed-in user without one to onboarding. */
export async function requireSession(): Promise<Session> {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  const session = await getSession();
  if (!session) redirect("/onboarding");
  return session;
}

/** Requires one of the given roles. ADMIN always passes. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const session = await requireSession();
  if (session.roles.includes("ADMIN")) return session;
  if (roles.some((r) => session.roles.includes(r))) return session;
  redirect("/dashboard?denied=1");
}

export function hasRole(session: Session, ...roles: Role[]): boolean {
  return session.roles.includes("ADMIN") || roles.some((r) => session.roles.includes(r));
}
