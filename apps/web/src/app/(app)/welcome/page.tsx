import { prisma } from "@strowger/db";
import { STEP_KEYS, readOnboarding, type StepKey } from "@strowger/shared/onboarding";
import { requireClientWorkspace } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { onboardingContext, startOnboarding } from "@/lib/onboarding";
import { rememberedMappings } from "../lists/import-actions";
import { Wizard, type WizardProps } from "./wizard";

// Client onboarding wizard (owner, 6 Nov). A client admin's first stop after
// sign-up and after the owner creates their workspace; reachable from the
// "Finish setup" banner until complete; the platform admin opens it for any
// client from /platform ("Open wizard"). docs/HANDOFF.md "Client onboarding wizard".
export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const s = await requireClientWorkspace("ADMIN");
  await startOnboarding(s.tenant);
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } });
  const state = readOnboarding(t.onboarding);
  const ctx = await onboardingContext(t, state);
  const sp = await searchParams;
  const startStep: StepKey = typeof sp.step === "string" && (STEP_KEYS as readonly string[]).includes(sp.step) ? (sp.step as StepKey) : "you";

  const [r, account, provider, registration, people] = await Promise.all([
    prisma.platformRates.findUnique({ where: { id: "default" }, select: { didMonthlyCents: true, prepayInstructions: true } }),
    prisma.billingAccount.findUnique({ where: { tenantId: t.id } }),
    engine<WizardProps["provider"]>("/payments/provider").catch(() => ({ id: "none", configured: false, label: "No card processor yet" })),
    t.tenDlcBrandId ? engine<WizardProps["registration"]>(`/onboarding/registration?tenantId=${encodeURIComponent(t.id)}`).catch(() => null) : Promise.resolve(null),
    prisma.user.findMany({ where: { tenantId: t.id, active: true, NOT: { roles: { has: "ADMIN" } } }, select: { email: true, roles: true, clerkUserId: true }, orderBy: { createdAt: "asc" }, take: 200 }),
  ]);

  // The first campaign and its list, if the leads step made them.
  let first: WizardProps["first"] = null;
  if (state.firstCampaign) {
    const [c, l, pinned] = await Promise.all([
      prisma.campaign.findFirst({ where: { id: state.firstCampaign.campaignId, tenantId: t.id }, select: { id: true, name: true } }),
      prisma.list.findFirst({ where: { id: state.firstCampaign.listId, tenantId: t.id }, select: { id: true, name: true, totalLeads: true } }),
      prisma.callerIdNumber.count({ where: { tenantId: t.id, campaignId: state.firstCampaign.campaignId, status: { not: "RETIRED" } } }),
    ]);
    if (c && l) {
      let needed = pinned;
      if (l.totalLeads > 0) {
        const plan = await engine<{ plan: { totals: { needed: number } } }>(`/campaigns/${encodeURIComponent(c.id)}/did-plan?tenantId=${encodeURIComponent(t.id)}`).catch(() => null);
        needed = Math.max(pinned, plan?.plan.totals.needed ?? 0);
      }
      first = { campaignId: c.id, campaignName: c.name, listId: l.id, listName: l.name, totalLeads: l.totalLeads, numbersPinned: pinned, numbersNeeded: needed };
    }
  }
  const remembered = first ? await rememberedMappings() : {};
  const priceCents = Math.round((r?.didMonthlyCents ?? 110) * (1 + (account?.didMarkupPct ?? 50) / 100));

  return (
    <Wizard
      key={t.id}
      tenantName={t.name}
      initial={state}
      ctx={ctx}
      startStep={startStep}
      acting={Boolean(s.actingFrom)}
      rates={{ seatMonthlyCents: account?.seatMonthlyCents ?? 7000, perMinuteMillicents: account?.perMinuteMillicents ?? 1200, numberMonthlyCents: priceCents, prepayInstructions: r?.prepayInstructions ?? null }}
      balanceCents={account?.balanceCents ?? 0}
      provider={provider}
      registration={registration}
      first={first}
      remembered={remembered}
      people={people.map((p) => ({ email: p.email, role: p.roles.includes("SUPERVISOR") ? "SUPERVISOR" : "AGENT", signedIn: Boolean(p.clerkUserId) }))}
    />
  );
}
