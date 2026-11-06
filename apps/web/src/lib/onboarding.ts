// Client onboarding wizard (/welcome): what the pages need around the stored
// answers. The rules are in `@strowger/shared/onboarding`; the answers are on
// `Tenant.onboarding`, edited only through `patchOnboarding`. See
// docs/HANDOFF.md "Client onboarding wizard".
import { patchOnboarding, prisma, type Tenant } from "@strowger/db";
import { onboardingProgress, readOnboarding, type OnboardingState, type Progress, type StepContext } from "@strowger/shared/onboarding";
import { registrationTone } from "@strowger/shared/tendlc";

type TenantLike = Pick<Tenant, "id" | "isPlatform" | "onboarding" | "tenDlcBrand" | "tenDlcCampaign">;

/** The 10DLC status worth showing: the campaign's once there is one, else the brand's. */
export function registrationStatusOf(t: Pick<Tenant, "tenDlcBrand" | "tenDlcCampaign">): string | null {
  const c = (t.tenDlcCampaign ?? null) as Record<string, unknown> | null;
  const b = (t.tenDlcBrand ?? null) as Record<string, unknown> | null;
  const v = c?.campaignStatus ?? c?.status ?? b?.identityStatus ?? b?.status;
  return v ? String(v) : null;
}

export async function onboardingContext(t: TenantLike, s: OnboardingState): Promise<StepContext> {
  const [account, paid, leads, invited] = await Promise.all([
    prisma.billingAccount.findUnique({ where: { tenantId: t.id }, select: { balanceCents: true } }),
    prisma.billingEntry.count({ where: { tenantId: t.id, kind: "PAYMENT" } }),
    s.firstCampaign ? prisma.list.aggregate({ where: { tenantId: t.id, campaignId: s.firstCampaign.campaignId }, _sum: { totalLeads: true } }) : null,
    prisma.user.count({ where: { tenantId: t.id, active: true, NOT: { roles: { has: "ADMIN" } } } }),
  ]);
  return { funded: t.isPlatform || paid > 0 || (account?.balanceCents ?? 0) > 0, leadCount: leads?._sum.totalLeads ?? 0, invitedCount: invited, registrationStatus: registrationStatusOf(t) };
}

export async function onboardingProgressFor(t: TenantLike): Promise<{ state: OnboardingState; ctx: StepContext; progress: Progress }> {
  const state = readOnboarding(t.onboarding);
  const ctx = await onboardingContext(t, state);
  return { state, ctx, progress: onboardingProgress(state, ctx) };
}

/** First visit: start the clock and fill in what we already know (the client's admin, the business name and phone). */
export async function startOnboarding(t: Pick<Tenant, "id" | "name" | "businessPhone" | "onboarding">): Promise<void> {
  const s = readOnboarding(t.onboarding);
  if (s.firstSeenAt) return;
  const admin = await prisma.user.findFirst({ where: { tenantId: t.id, active: true, roles: { has: "ADMIN" } }, orderBy: { createdAt: "asc" }, select: { email: true, firstName: true, lastName: true, mobilePhone: true } });
  const you = s.steps.you ?? {};
  const business = s.steps.business ?? {};
  await patchOnboarding(t.id, [
    { set: ["firstSeenAt"], value: new Date().toISOString() },
    {
      merge: ["steps", "you"],
      value: {
        name: you.name || [admin?.firstName, admin?.lastName].filter(Boolean).join(" ") || undefined,
        email: you.email || admin?.email || undefined,
        mobile: you.mobile || admin?.mobilePhone || undefined,
      },
    },
    { merge: ["steps", "business"], value: { legalName: business.legalName || t.name, phone: business.phone || t.businessPhone || undefined } },
  ]);
}

/** The wizard's business answers as the Free Caller Registry profile fields (Settings prefill). */
export function fcrPrefill(t: Pick<Tenant, "onboarding">): Record<string, string> {
  const s = readOnboarding(t.onboarding);
  const b = s.steps.business ?? {};
  const y = s.steps.you ?? {};
  const out: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => {
    if (v && v.trim()) out[k] = v.trim();
  };
  put("companyName", b.dba || b.legalName);
  put("address1", b.street);
  put("city", b.city);
  put("state", b.state?.toUpperCase());
  put("zip", b.zip);
  put("website", b.website);
  put("contactName", y.name);
  put("contactPhone", (b.phone ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1"));
  return out;
}

/** One row on /platform: steps done, 10DLC, payment. */
export interface OnboardingRow {
  done: number;
  total: number;
  complete: boolean;
  started: boolean;
  tenDlc: "none" | "pending" | "approved" | "rejected";
  tenDlcStatus: string | null;
  payment: "funded" | "link requested" | "none";
  paymentRequestCents: number | null;
  reserve: string | null;
}

export async function onboardingRows(tenantIds: string[]): Promise<Record<string, OnboardingRow>> {
  if (!tenantIds.length) return {};
  const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, isPlatform: true, onboarding: true, tenDlcBrand: true, tenDlcCampaign: true } });
  const out: Record<string, OnboardingRow> = {};
  await Promise.all(
    tenants.map(async (t) => {
      const { state, ctx, progress } = await onboardingProgressFor(t);
      const status = registrationStatusOf(t);
      out[t.id] = {
        done: progress.done,
        total: progress.total,
        complete: progress.complete,
        started: Boolean(state.firstSeenAt),
        tenDlc: state.registration?.brandSubmittedAt || status ? registrationTone(status ?? "PENDING") : "none",
        tenDlcStatus: status,
        payment: ctx.funded ? "funded" : state.paymentRequest ? "link requested" : "none",
        paymentRequestCents: state.paymentRequest?.amountCents ?? null,
        reserve: state.reserve?.state ?? null,
      };
    }),
  );
  return out;
}
