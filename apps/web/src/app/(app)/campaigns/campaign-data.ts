// Typed wrappers over @strowger/shared/campaign-form for the campaign actions
// (no "use server": these are helpers, not actions).
import { randomBytes } from "node:crypto";
import type { PrismaClient, CallerIdMode, CampaignStatus, DialMode, HopperOrder, ListSelection, ScreenerAction, VoicemailAction, VoicemailMode } from "@strowger/db";
import { parseCampaignSettings, type CampaignEnumsBefore, type Get } from "@strowger/shared/campaign-form";

/** The campaign row update the page has always written, with Prisma's enum types. */
export function campaignSettingsData(get: Get, before: CampaignEnumsBefore) {
  const d = parseCampaignSettings(get, before);
  return {
    ...d,
    status: d.status as CampaignStatus,
    dialMode: d.dialMode as DialMode,
    voicemailAction: d.voicemailAction as VoicemailAction,
    voicemailMode: d.voicemailMode as VoicemailMode,
    screenerAction: d.screenerAction as ScreenerAction,
    callerIdMode: d.callerIdMode as CallerIdMode,
    hopperOrder: d.hopperOrder as HopperOrder,
    listSelection: d.listSelection as ListSelection,
  };
}

/** A fixed caller ID must be one of the workspace's ACTIVE numbers (works on the client or inside a transaction). */
export async function ownsActiveNumber(db: Pick<PrismaClient, "callerIdNumber">, tenantId: string, phone: string): Promise<boolean> {
  return Boolean(await db.callerIdNumber.findFirst({ where: { tenantId, phone, status: "ACTIVE" }, select: { id: true } }));
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}
