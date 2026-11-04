"use server";

import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

async function own() {
  return requireRole("SUPERVISOR");
}

export async function createRoom(formData: FormData) {
  const s = await own();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const supervisorId = String(formData.get("supervisorId") ?? "") || null;
  await prisma.room.create({ data: { tenantId: s.tenant.id, name, supervisorId } });
  revalidatePath("/teams");
}

export async function updateRoom(formData: FormData) {
  const s = await own();
  const id = String(formData.get("id"));
  const supervisorId = String(formData.get("supervisorId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  await prisma.room.updateMany({ where: { id, tenantId: s.tenant.id }, data: { supervisorId, ...(name ? { name } : {}) } });
  revalidatePath("/teams");
}

export async function deleteRoom(formData: FormData) {
  const s = await own();
  const id = String(formData.get("id"));
  await prisma.team.updateMany({ where: { roomId: id, tenantId: s.tenant.id }, data: { roomId: null } });
  await prisma.room.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/teams");
}

export async function createTeam(formData: FormData) {
  const s = await own();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");
  const leaderId = String(formData.get("leaderId") ?? "") || null;
  const roomId = String(formData.get("roomId") ?? "") || null;
  await prisma.team.create({ data: { tenantId: s.tenant.id, name, leaderId, roomId } });
  revalidatePath("/teams");
}

export async function updateTeam(formData: FormData) {
  const s = await own();
  const id = String(formData.get("id"));
  const leaderId = String(formData.get("leaderId") ?? "") || null;
  const roomId = String(formData.get("roomId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  await prisma.team.updateMany({ where: { id, tenantId: s.tenant.id }, data: { leaderId, roomId, ...(name ? { name } : {}) } });
  revalidatePath("/teams");
}

export async function deleteTeam(formData: FormData) {
  const s = await own();
  const id = String(formData.get("id"));
  await prisma.team.deleteMany({ where: { id, tenantId: s.tenant.id } });
  revalidatePath("/teams");
}

/** Set a person's team and room in one go (a person is in at most one of each). */
export async function assignPerson(formData: FormData) {
  const s = await own();
  const userId = String(formData.get("userId"));
  const teamId = String(formData.get("teamId") ?? "") || null;
  const roomId = String(formData.get("roomId") ?? "") || null;
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId: s.tenant.id }, select: { id: true } });
  if (!user) throw new Error("Unknown person");
  await prisma.$transaction(async (tx) => {
    await tx.userTeam.deleteMany({ where: { userId } });
    await tx.userRoom.deleteMany({ where: { userId } });
    if (teamId) {
      const team = await tx.team.findFirst({ where: { id: teamId, tenantId: s.tenant.id }, select: { id: true, roomId: true } });
      if (team) await tx.userTeam.create({ data: { userId, teamId } });
      // A team inside a room puts its members in that room too.
      if (team?.roomId && !roomId) await tx.userRoom.create({ data: { userId, roomId: team.roomId } });
    }
    if (roomId) {
      const room = await tx.room.findFirst({ where: { id: roomId, tenantId: s.tenant.id }, select: { id: true } });
      if (room) await tx.userRoom.create({ data: { userId, roomId } });
    }
  });
  revalidatePath("/teams");
}
