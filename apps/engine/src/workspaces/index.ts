// Client workspaces (owner, 5 Nov: "build it so I can build it myself"):
// create one, and move a whole campaign into one. A campaign brings its
// lists, leads and their history, calls, messages, callbacks, dispositions,
// dial plans, scripts, webhooks, the numbers pinned to it, its agents (when
// they belong to no other campaign), copies of the cadence profiles and
// audio its lists and settings point at, and the workspace's system
// do-not-call list.
import { prisma } from "@strowger/db";
import { log } from "../log";

export async function createWorkspace(name: string, adminEmail: string | null): Promise<{ id: string; slug: string }> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "client";
  let slug = base;
  for (let i = 2; await prisma.tenant.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  // The onboarding wizard (/welcome) opens with what the owner already typed.
  const onboarding = { steps: { you: adminEmail ? { email: adminEmail.trim().toLowerCase() } : {}, business: { legalName: name.trim() } }, meta: {}, createdBy: "platform" };
  const t = await prisma.tenant.create({ data: { name: name.trim(), slug, onboarding } });
  await prisma.billingAccount.create({ data: { tenantId: t.id } });
  if (adminEmail) {
    const email = adminEmail.trim().toLowerCase();
    await prisma.user.create({ data: { tenantId: t.id, email, roles: ["ADMIN"], active: true } });
  }
  return { id: t.id, slug: t.slug };
}

export interface MoveReport {
  campaign: string;
  lists: number;
  leads: number;
  calls: number;
  messages: number;
  numbers: number;
  people: number;
  cadences: number;
  audio: number;
  dnc: number;
}

/** Move a campaign and everything it owns from one workspace to another, in one transaction. */
export async function moveCampaign(campaignId: string, fromTenantId: string, toTenantId: string): Promise<MoveReport> {
  if (fromTenantId === toTenantId) throw new Error("Already in that workspace");
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: fromTenantId }, include: { lists: { select: { id: true, cadenceProfileId: true, affiliateId: true } }, agents: { select: { userId: true } } } });
  if (!campaign) throw new Error("Unknown campaign in the source workspace");
  const target = await prisma.tenant.findUnique({ where: { id: toTenantId } });
  if (!target) throw new Error("Unknown target workspace");

  const listIds = campaign.lists.map((l) => l.id);
  const leadIds = (await prisma.lead.findMany({ where: { listId: { in: listIds } }, select: { id: true } })).map((l) => l.id);
  const callIds = (await prisma.call.findMany({ where: { campaignId }, select: { id: true } })).map((c) => c.id);

  // People: agents on this campaign who are on no other campaign in the source workspace.
  const agentIds = campaign.agents.map((a) => a.userId);
  const elsewhere = await prisma.campaignAgent.findMany({ where: { userId: { in: agentIds }, campaignId: { not: campaignId } }, select: { userId: true } });
  const stay = new Set(elsewhere.map((e) => e.userId));
  const moveUserIds = agentIds.filter((id) => !stay.has(id));

  // Cadence profiles and audio: copied, since other campaigns in the source may use them.
  const cadenceIds = [...new Set(campaign.lists.map((l) => l.cadenceProfileId).filter((x): x is string => Boolean(x)))];
  const audioIds = [...new Set([campaign.safeHarborAudioId, campaign.voicemailDropAudioId, campaign.screenerAudioId, campaign.disclosureAudioId].filter((x): x is string => Boolean(x)))];

  const report = await prisma.$transaction(async (tx) => {
    const cadenceMap = new Map<string, string>();
    for (const id of cadenceIds) {
      const c = await tx.cadenceProfile.findUnique({ where: { id } });
      if (!c) continue;
      const { id: _old, tenantId: _t, ...rest } = c;
      void _old;
      void _t;
      const existing = await tx.cadenceProfile.findFirst({ where: { tenantId: toTenantId, name: c.name } });
      const created = existing ?? (await tx.cadenceProfile.create({ data: { ...rest, dayparts: rest.dayparts ?? undefined, tenantId: toTenantId } }));
      cadenceMap.set(id, created.id);
    }
    const audioMap = new Map<string, string>();
    for (const id of audioIds) {
      const a = await tx.audioAsset.findUnique({ where: { id } });
      if (!a) continue;
      const { id: _old, tenantId: _t, ...rest } = a;
      void _old;
      void _t;
      const existing = await tx.audioAsset.findFirst({ where: { tenantId: toTenantId, name: a.name } });
      const created = existing ?? (await tx.audioAsset.create({ data: { ...rest, tenantId: toTenantId } }));
      audioMap.set(id, created.id);
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        tenantId: toTenantId,
        safeHarborAudioId: campaign.safeHarborAudioId ? audioMap.get(campaign.safeHarborAudioId) : undefined,
        voicemailDropAudioId: campaign.voicemailDropAudioId ? audioMap.get(campaign.voicemailDropAudioId) : undefined,
        screenerAudioId: campaign.screenerAudioId ? audioMap.get(campaign.screenerAudioId) : undefined,
        disclosureAudioId: campaign.disclosureAudioId ? audioMap.get(campaign.disclosureAudioId) : undefined,
      },
    });
    for (const l of campaign.lists) {
      await tx.list.update({ where: { id: l.id }, data: { tenantId: toTenantId, cadenceProfileId: l.cadenceProfileId ? (cadenceMap.get(l.cadenceProfileId) ?? null) : undefined, affiliateId: null } });
    }
    const leads = await tx.lead.updateMany({ where: { id: { in: leadIds } }, data: { tenantId: toTenantId } });
    await tx.leadEvent.updateMany({ where: { leadId: { in: leadIds } }, data: { tenantId: toTenantId } });
    const calls = await tx.call.updateMany({ where: { id: { in: callIds } }, data: { tenantId: toTenantId } });
    await tx.transfer.updateMany({ where: { callId: { in: callIds } }, data: { tenantId: toTenantId } });
    await tx.voicemail.updateMany({ where: { callId: { in: callIds } }, data: { tenantId: toTenantId } });
    const messages = await tx.message.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.callback.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.disposition.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.transferDestination.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.dialPlan.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.script.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.webhookEndpoint.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.abandonLedger.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.agentSession.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.campaignAgent.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    await tx.dncEntry.updateMany({ where: { campaignId, scope: "CAMPAIGN" }, data: { tenantId: toTenantId } });
    await tx.numberOrder.updateMany({ where: { campaignId }, data: { tenantId: toTenantId } });
    const numbers = await tx.callerIdNumber.updateMany({ where: { campaignId, tenantId: fromTenantId }, data: { tenantId: toTenantId, ivrId: null, queueId: null, routeUserId: null } });
    // People who only work this campaign: they move with it, with their voicemail box and game state.
    const people = await tx.user.updateMany({ where: { id: { in: moveUserIds }, tenantId: fromTenantId, NOT: { roles: { has: "ADMIN" } } }, data: { tenantId: toTenantId } });
    await tx.voicemailBox.updateMany({ where: { ownerId: { in: moveUserIds } }, data: { tenantId: toTenantId } });
    await tx.pointsLedger.updateMany({ where: { userId: { in: moveUserIds } }, data: { tenantId: toTenantId } });
    await tx.pokerCard.updateMany({ where: { userId: { in: moveUserIds } }, data: { tenantId: toTenantId } });
    await tx.userTeam.deleteMany({ where: { userId: { in: moveUserIds } } });
    await tx.userRoom.deleteMany({ where: { userId: { in: moveUserIds } } });
    // Agents who stay behind are no longer on this campaign (it is in another workspace now).
    await tx.campaignAgent.deleteMany({ where: { campaignId, userId: { in: [...stay] } } });
    // The system do-not-call list is the business's own; the new workspace gets a copy.
    const dnc = await tx.dncEntry.findMany({ where: { tenantId: fromTenantId, scope: "SYSTEM" } });
    let copied = 0;
    if (dnc.length) {
      const r = await tx.dncEntry.createMany({ data: dnc.map((d) => ({ tenantId: toTenantId, phone: d.phone, scope: "SYSTEM" as const, source: d.source, note: d.note })), skipDuplicates: true });
      copied = r.count;
    }
    return { campaign: campaign.name, lists: listIds.length, leads: leads.count, calls: calls.count, messages: messages.count, numbers: numbers.count, people: people.count, cadences: cadenceMap.size, audio: audioMap.size, dnc: copied };
  });
  log.info({ campaignId, fromTenantId, toTenantId, report }, "campaign moved to another workspace");
  return report;
}
