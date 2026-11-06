// A new campaign with the default dispositions and dial plans. Used by
// "Create campaign" (campaigns/actions.ts) and by the onboarding wizard's
// first campaign (welcome/actions.ts). Not a server action: callers check
// the session first.
import { prisma, type DialMode } from "@strowger/db";

export const DEFAULT_DISPOSITIONS = [
  { code: "SALE", label: "Sale", isContact: true, isSale: true, hotkey: "1" },
  { code: "CB", label: "Callback", isContact: true, isCallback: true, hotkey: "2" },
  { code: "NI", label: "Not interested", isContact: true, hotkey: "3" },
  { code: "NA", label: "No answer", recycleAfterMinutes: 180, hotkey: "4" },
  { code: "VM", label: "Voicemail", recycleAfterMinutes: 240, hotkey: "5" },
  { code: "BUSY", label: "Busy", recycleAfterMinutes: 60, hotkey: "6" },
  { code: "WN", label: "Wrong number", hotkey: "7" },
  { code: "DNC", label: "Do not call", isContact: true, isDnc: true, hotkey: "9" },
];

export async function createCampaignRecord(tenant: { id: string; settings: unknown }, input: { name: string; dialMode: DialMode; localWindowStart?: number; localWindowEnd?: number }) {
  // Games defaults (Settings → Games); bets stay off until switched on for the campaign.
  const g = ((tenant.settings ?? {}) as { games?: { weeklyPoints?: number; maxStake?: number } }).games ?? {};
  return prisma.campaign.create({
    data: {
      tenantId: tenant.id,
      name: input.name,
      dialMode: input.dialMode,
      ...(input.localWindowStart !== undefined ? { localWindowStart: input.localWindowStart } : {}),
      ...(input.localWindowEnd !== undefined ? { localWindowEnd: input.localWindowEnd } : {}),
      weeklyPoints: Math.max(0, Math.min(1_000_000, Number(g.weeklyPoints) || 10_000)),
      maxStake: Math.max(1, Math.min(1_000_000, Number(g.maxStake) || 5_000)),
      dispositions: { create: DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, tenantId: tenant.id, sortOrder: i })) },
      dialPlans: {
        create: [
          { tenantId: tenant.id, leadType: null, ageFromDays: 0, ageToDays: 0, attemptsPerDay: 3, retryGapMinutes: 60, weight: 100 },
          { tenantId: tenant.id, leadType: null, ageFromDays: 1, ageToDays: 7, attemptsPerDay: 2, retryGapMinutes: 180, weight: 50 },
          { tenantId: tenant.id, leadType: null, ageFromDays: 8, ageToDays: null, attemptsPerDay: 1, retryGapMinutes: 1440, weight: 10 },
        ],
      },
    },
  });
}
