"use server";

import { prisma, type InboundRoute } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

async function own() {
  return requireRole("SUPERVISOR");
}
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => str(fd, k) || null;

export async function setNumberRoute(formData: FormData) {
  const s = await own();
  const id = str(formData, "id");
  const routeTo = str(formData, "routeTo") as InboundRoute;
  const target = opt(formData, "target");
  await prisma.callerIdNumber.updateMany({
    where: { id, tenantId: s.tenant.id },
    data: { routeTo, ivrId: routeTo === "IVR" ? target : null, queueId: routeTo === "QUEUE" ? target : null, routeUserId: routeTo === "USER" ? target : null },
  });
  revalidatePath("/inbound");
}

// ── IVRs ──
export async function saveIvr(formData: FormData) {
  const s = await own();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const options = [];
  for (let i = 0; i < 10; i++) {
    const action = str(formData, `opt${i}Action`);
    if (!action) continue;
    options.push({ digit: String(i), label: str(formData, `opt${i}Label`), action, targetId: opt(formData, `opt${i}Target`) });
  }
  const data = {
    tenantId: s.tenant.id,
    name,
    greetingAudioId: opt(formData, "greetingAudioId"),
    options,
    allowExtensions: formData.get("allowExtensions") === "on",
    timeoutSeconds: Math.max(2, Math.min(20, Number(formData.get("timeoutSeconds")) || 6)),
    repeats: Math.max(0, Math.min(5, Number(formData.get("repeats")) || 2)),
    timeoutAction: str(formData, "timeoutAction") || "HANGUP",
    timeoutTargetId: opt(formData, "timeoutTarget"),
  };
  if (id) await prisma.ivr.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.ivr.create({ data });
  revalidatePath("/inbound");
}

export async function deleteIvr(formData: FormData) {
  const s = await own();
  const id = str(formData, "id");
  await prisma.callerIdNumber.updateMany({ where: { ivrId: id, tenantId: s.tenant.id }, data: { ivrId: null, routeTo: "CAMPAIGN" } });
  await prisma.ivr.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Queues ──
export async function saveQueue(formData: FormData) {
  const s = await own();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const requiredSkills = formData
    .getAll("skillId")
    .map(String)
    .filter(Boolean)
    .map((skillId) => ({ skillId, minLevel: Math.max(1, Math.min(5, Number(formData.get(`minLevel_${skillId}`)) || 1)) }));
  const data = {
    tenantId: s.tenant.id,
    name,
    requiredSkills,
    campaignId: opt(formData, "campaignId"),
    holdAudioId: opt(formData, "holdAudioId"),
    maxWaitSeconds: Math.max(15, Math.min(3600, Number(formData.get("maxWaitSeconds")) || 300)),
    overflowAction: str(formData, "overflowAction") || "VOICEMAIL",
    overflowQueueId: opt(formData, "overflowQueueId"),
    voicemailBoxId: opt(formData, "voicemailBoxId"),
  };
  if (id) await prisma.queue.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.queue.create({ data });
  revalidatePath("/inbound");
}

export async function deleteQueue(formData: FormData) {
  const s = await own();
  const id = str(formData, "id");
  await prisma.callerIdNumber.updateMany({ where: { queueId: id, tenantId: s.tenant.id }, data: { queueId: null, routeTo: "CAMPAIGN" } });
  await prisma.queue.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Voicemail boxes ──
export async function saveBox(formData: FormData) {
  const s = await own();
  const id = opt(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const data = { tenantId: s.tenant.id, name, ownerId: opt(formData, "ownerId"), greetingAudioId: opt(formData, "greetingAudioId"), notifyEmail: opt(formData, "notifyEmail") };
  if (id) await prisma.voicemailBox.updateMany({ where: { id, tenantId: s.tenant.id }, data });
  else await prisma.voicemailBox.create({ data });
  revalidatePath("/inbound");
}

export async function deleteBox(formData: FormData) {
  const s = await own();
  const id = str(formData, "id");
  await prisma.queue.updateMany({ where: { voicemailBoxId: id, tenantId: s.tenant.id }, data: { voicemailBoxId: null } });
  await prisma.voicemailBox.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/inbound");
}

// ── Skills ──
export async function saveSkill(formData: FormData) {
  const s = await own();
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  await prisma.skill.upsert({ where: { tenantId_name: { tenantId: s.tenant.id, name } }, create: { tenantId: s.tenant.id, name }, update: {} });
  revalidatePath("/skills");
}

export async function deleteSkill(formData: FormData) {
  const s = await own();
  await prisma.skill.deleteMany({ where: { id: str(formData, "id"), tenantId: s.tenant.id } });
  revalidatePath("/skills");
}

/** Set one agent's level on one skill; 0 removes it. */
export async function setAgentSkill(formData: FormData) {
  const s = await own();
  const userId = str(formData, "userId");
  const skillId = str(formData, "skillId");
  const level = Math.max(0, Math.min(5, Number(formData.get("level")) || 0));
  const [u, k] = await Promise.all([prisma.user.findFirst({ where: { id: userId, tenantId: s.tenant.id }, select: { id: true } }), prisma.skill.findFirst({ where: { id: skillId, tenantId: s.tenant.id }, select: { id: true } })]);
  if (!u || !k) throw new Error("Unknown person or skill");
  if (level === 0) await prisma.agentSkill.deleteMany({ where: { userId, skillId } });
  else await prisma.agentSkill.upsert({ where: { userId_skillId: { userId, skillId } }, create: { userId, skillId, level }, update: { level } });
  revalidatePath("/skills");
}

export async function setExtension(formData: FormData) {
  const s = await own();
  const userId = str(formData, "userId");
  const ext = str(formData, "extension").replace(/\D/g, "").slice(0, 5) || null;
  if (ext) {
    const clash = await prisma.user.findFirst({ where: { tenantId: s.tenant.id, extension: ext, id: { not: userId } }, select: { id: true } });
    if (clash) throw new Error(`Extension ${ext} is taken`);
  }
  await prisma.user.updateMany({ where: { id: userId, tenantId: s.tenant.id }, data: { extension: ext } });
  revalidatePath("/skills");
  revalidatePath(`/people/${userId}`);
}

// ── Voicemails ──
export async function setVoicemailStatus(formData: FormData) {
  const s = await requireRole("AGENT", "TEAM_LEADER", "SUPERVISOR");
  const id = str(formData, "id");
  const status = str(formData, "status") as "NEW" | "LISTENED" | "DONE";
  await prisma.voicemail.updateMany({ where: { id, tenantId: s.tenant.id }, data: { status } });
  revalidatePath("/voicemails");
}
