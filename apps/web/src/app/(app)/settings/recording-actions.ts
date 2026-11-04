"use server";

import { Prisma, prisma } from "@strowger/db";
import { encryptString } from "@strowger/shared/secrets";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";

export async function saveRecordingPolicy(formData: FormData) {
  const s = await requireRole("ADMIN");
  const days = Math.max(7, Math.min(365, Number(formData.get("retentionDays")) || 60));
  const type = String(formData.get("exportType") ?? "none");
  const secret = process.env.ENGINE_INTERNAL_KEY ?? "";
  const current = (s.tenant.recordingExport ?? null) as Record<string, unknown> | null;
  let recordingExport: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  if (type === "sftp") {
    const password = String(formData.get("sftpPassword") ?? "");
    recordingExport = {
      type: "sftp",
      host: String(formData.get("sftpHost") ?? "").trim(),
      port: Number(formData.get("sftpPort")) || 22,
      username: String(formData.get("sftpUser") ?? "").trim(),
      // Keep the stored password when the field is left blank.
      password: password ? encryptString(password, secret) : String(current?.password ?? ""),
      path: String(formData.get("sftpPath") ?? "/recordings").trim() || "/recordings",
    };
  } else if (type === "dropbox") {
    const token = String(formData.get("dropboxToken") ?? "");
    recordingExport = { type: "dropbox", token: token ? encryptString(token, secret) : String(current?.token ?? ""), path: String(formData.get("dropboxPath") ?? "/Strowger").trim() || "/Strowger" };
  }
  await prisma.tenant.update({ where: { id: s.tenant.id }, data: { recordingRetentionDays: days, recordingExport } });
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "recordings.policy", after: { days, type } } });
  revalidatePath("/settings");
}

export async function runRecordingExportNow() {
  await requireRole("ADMIN");
  const { engine } = await import("@/lib/engine");
  await engine("/recordings/run", { method: "POST", body: "{}" }).catch(() => undefined);
  revalidatePath("/settings");
}
