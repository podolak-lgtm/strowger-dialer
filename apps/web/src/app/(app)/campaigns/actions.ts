"use server";

import { prisma, type CampaignStatus, type DialMode, type ScreenerAction, type VoicemailAction, type VoicemailMode, type CallerIdMode, type HopperOrder, type ListSelection } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";

const DEFAULT_DISPOSITIONS = [
  { code: "SALE", label: "Sale", isContact: true, isSale: true, hotkey: "1" },
  { code: "CB", label: "Callback", isContact: true, isCallback: true, hotkey: "2" },
  { code: "NI", label: "Not interested", isContact: true, hotkey: "3" },
  { code: "NA", label: "No answer", recycleAfterMinutes: 180, hotkey: "4" },
  { code: "VM", label: "Voicemail", recycleAfterMinutes: 240, hotkey: "5" },
  { code: "BUSY", label: "Busy", recycleAfterMinutes: 60, hotkey: "6" },
  { code: "WN", label: "Wrong number", hotkey: "7" },
  { code: "DNC", label: "Do not call", isContact: true, isDnc: true, hotkey: "9" },
];

export async function createCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const name = String(formData.get("name") ?? "").trim();
  const dialMode = String(formData.get("dialMode") ?? "PREVIEW") as DialMode;
  if (!name) throw new Error("Name is required");
  const c = await prisma.campaign.create({
    data: {
      tenantId: s.tenant.id,
      name,
      dialMode,
      dispositions: { create: DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, tenantId: s.tenant.id, sortOrder: i })) },
      dialPlans: {
        create: [
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 0, ageToDays: 0, attemptsPerDay: 3, retryGapMinutes: 60, weight: 100 },
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 1, ageToDays: 7, attemptsPerDay: 2, retryGapMinutes: 180, weight: 50 },
          { tenantId: s.tenant.id, leadType: null, ageFromDays: 8, ageToDays: null, attemptsPerDay: 1, retryGapMinutes: 1440, weight: 10 },
        ],
      },
    },
  });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.create", target: c.id, after: { name, dialMode } } });
  redirect(`/campaigns/${c.id}`);
}

function num(formData: FormData, key: string, fallback: number): number {
  const v = Number(formData.get(key));
  return Number.isFinite(v) ? v : fallback;
}

export async function updateCampaign(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("id"));
  const before = await prisma.campaign.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!before) throw new Error("Unknown campaign");

  const ratio = Math.max(1, num(formData, "ratio", 1));
  const maxRatio = Math.max(ratio, num(formData, "maxRatio", 3));
  const maxAttemptsPerDay = Math.max(1, Math.min(10, num(formData, "maxAttemptsPerDay", 3)));

  const data = {
    name: String(formData.get("name") ?? before.name).trim() || before.name,
    status: String(formData.get("status") ?? before.status) as CampaignStatus,
    dialMode: String(formData.get("dialMode") ?? before.dialMode) as DialMode,
    ratio,
    maxRatio,
    abandonCapPct: Math.min(3, Math.max(0.5, num(formData, "abandonCapPct", 3))),
    abandonWarnPct: Math.max(0.5, num(formData, "abandonWarnPct", 2.5)),
    abandonTimerMs: Math.max(500, Math.min(2000, num(formData, "abandonTimerMs", 2000))),
    amdEnabled: formData.get("amdEnabled") === "on",
    voicemailNotifySms: formData.get("voicemailNotifySms") === "on",
    voicemailAction: String(formData.get("voicemailAction") ?? before.voicemailAction) as VoicemailAction,
    voicemailMode: String(formData.get("voicemailMode") ?? before.voicemailMode) as VoicemailMode,
    voicemailScript: String(formData.get("voicemailScript") ?? "").trim() || null,
    voicemailRetryMinutes: Math.max(15, num(formData, "voicemailRetryMinutes", 240)),
    screenerDetection: formData.get("screenerDetection") === "on",
    screenerAction: String(formData.get("screenerAction") ?? before.screenerAction) as ScreenerAction,
    screenerScript: String(formData.get("screenerScript") ?? "").trim() || null,
    recordingOn: formData.get("recordingOn") === "on",
    disclosureOn: formData.get("disclosureOn") === "on",
    callerIdMode: String(formData.get("callerIdMode") ?? before.callerIdMode) as CallerIdMode,
    fixedCallerId: String(formData.get("fixedCallerId") ?? "").replace(/\D/g, "").slice(-10) || null,
    localWindowStart: Math.max(0, Math.min(23, num(formData, "localWindowStart", 9))),
    localWindowEnd: Math.max(1, Math.min(24, num(formData, "localWindowEnd", 20))),
    maxAttemptsPerDay,
    wrapUpSeconds: Math.max(0, num(formData, "wrapUpSeconds", 30)),
    hopperOrder: String(formData.get("hopperOrder") ?? before.hopperOrder) as HopperOrder,
    listSelection: String(formData.get("listSelection") ?? before.listSelection) as ListSelection,
    closersMayDial: formData.get("closersMayDial") === "on",
    callbackOwnerMinutes: Math.max(0, num(formData, "callbackOwnerMinutes", 30)),
  };
  await prisma.campaign.update({ where: { id }, data });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.update", target: id, before: before as object, after: data } });
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
}

export async function saveDialPlan(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const id = String(formData.get("planId") ?? "");
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  const data = {
    tenantId: s.tenant.id,
    campaignId,
    leadType: String(formData.get("leadType") ?? "").trim() || null,
    ageFromDays: Math.max(0, num(formData, "ageFromDays", 0)),
    ageToDays: formData.get("ageToDays") === "" ? null : Math.max(0, num(formData, "ageToDays", 0)),
    attemptsPerDay: Math.max(1, Math.min(10, num(formData, "attemptsPerDay", 3))),
    retryGapMinutes: Math.max(5, num(formData, "retryGapMinutes", 180)),
    weight: num(formData, "weight", 0),
    active: formData.get("active") !== "off",
  };
  if (id) await prisma.dialPlan.update({ where: { id }, data });
  else await prisma.dialPlan.create({ data });
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function deleteDialPlan(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const id = String(formData.get("planId"));
  const plan = await prisma.dialPlan.findFirst({ where: { id, tenantId: s.tenant.id } });
  if (!plan) return;
  await prisma.dialPlan.delete({ where: { id } });
  revalidatePath(`/campaigns/${plan.campaignId}`);
}

export async function saveDisposition(formData: FormData) {
  const s = await requireRole("SUPERVISOR");
  const campaignId = String(formData.get("campaignId"));
  const id = String(formData.get("dispositionId") ?? "");
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: s.tenant.id }, select: { id: true } });
  if (!c) throw new Error("Unknown campaign");
  const code = String(formData.get("code") ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 12);
  const label = String(formData.get("label") ?? "").trim();
  if (!code || !label) throw new Error("Code and label are required");
  const recycle = String(formData.get("recycleAfterMinutes") ?? "");
  const data = {
    tenantId: s.tenant.id,
    campaignId,
    code,
    label,
    hotkey: String(formData.get("hotkey") ?? "").trim().slice(0, 1) || null,
    isContact: formData.get("isContact") === "on",
    isSale: formData.get("isSale") === "on",
    isDnc: formData.get("isDnc") === "on",
    isCallback: formData.get("isCallback") === "on",
    recycleAfterMinutes: recycle === "" ? null : Math.max(1, Number(recycle) || 1),
    active: formData.get("active") !== "off",
  };
  if (id) await prisma.disposition.update({ where: { id }, data });
  else await prisma.disposition.create({ data: { ...data, sortOrder: 99 } });
  revalidatePath(`/campaigns/${campaignId}`);
}
