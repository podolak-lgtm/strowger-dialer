"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@strowger/db";
import { REFERRAL_COOKIE } from "@strowger/shared/referrals";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { engine } from "@/lib/engine";

type SignupResult = { ok: true; tenantId: string; trial: boolean; referredBy: string | null } | { ok: false; error: string; trialRefused?: boolean };

/**
 * A first-time user's workspace. The engine creates it (tenant, admin,
 * billing account, and the free trial with its allowance and the referral
 * when the strowger_ref cookie points at a client), because the trial
 * allowance is a ledger entry and the engine owns the ledger.
 */
export async function createTenant(formData: FormData) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) redirect("/sign-in");
  const clerk = await currentUser();
  const email = clerk?.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!email) throw new Error("Your account has no email address");
  if (await prisma.user.findUnique({ where: { clerkUserId } })) redirect("/dashboard");

  const jar = await cookies();
  const body = {
    clerkUserId,
    email,
    firstName: clerk?.firstName ?? null,
    lastName: clerk?.lastName ?? null,
    companyName: String(formData.get("name") ?? "").trim(),
    businessPhone: String(formData.get("businessPhone") ?? "").trim() || null,
    refCode: jar.get(REFERRAL_COOKIE)?.value ?? null,
    acceptTrialTerms: formData.get("acceptTrialTerms") === "on",
    acceptUsageTerms: formData.get("acceptUsageTerms") === "on",
    withoutTrial: formData.get("withoutTrial") === "1",
  };
  let r: SignupResult;
  try {
    r = await engine<SignupResult>("/signup", { method: "POST", body: JSON.stringify(body) });
  } catch {
    redirect("/onboarding?error=" + encodeURIComponent("Could not create the workspace just now. Try again in a minute."));
  }
  if (!r.ok) redirect(`/onboarding?${r.trialRefused ? "refused" : "error"}=${encodeURIComponent(r.error)}`);
  jar.delete(REFERRAL_COOKIE);
  redirect("/dashboard");
}
