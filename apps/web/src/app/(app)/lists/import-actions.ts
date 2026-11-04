"use server";

// CSV import, driven by the browser: the file is parsed there (papaparse),
// mapped to our fields there, and sent here in batches. Nothing is stored
// but the rows that become leads and the import's counts, so there is no
// file storage to run and no upload size ceiling to hit.
import { prisma } from "@strowger/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { intakeBatch, loadList } from "@/lib/intake";

export interface BatchCounts {
  accepted: number;
  duplicate: number;
  badPhone: number;
  dnc: number;
  invalid: number;
}

export async function startImport(listId: string, fileName: string, mapping: Record<string, string>, totalRows: number): Promise<{ importId: string }> {
  const s = await requireRole("SUPERVISOR");
  const list = await loadList(s.tenant.id, listId);
  if (!list) throw new Error("Unknown list");
  const imp = await prisma.listImport.create({
    data: { listId, fileName, mapping, totalRows, status: "PROCESSING" },
  });
  // Remember the mapping for next time on this tenant (by header set).
  const settings = (s.tenant.settings ?? {}) as Record<string, unknown>;
  const remembered = (settings.importMappings as Record<string, Record<string, string>> | undefined) ?? {};
  const key = Object.keys(mapping).sort().join("|");
  remembered[key] = mapping;
  await prisma.tenant.update({ where: { id: s.tenant.id }, data: { settings: { ...settings, importMappings: remembered } } });
  return { importId: imp.id };
}

export async function importBatch(importId: string, rows: Record<string, unknown>[]): Promise<BatchCounts> {
  const s = await requireRole("SUPERVISOR");
  const imp = await prisma.listImport.findFirst({ where: { id: importId, list: { tenantId: s.tenant.id } }, include: { list: true } });
  if (!imp || imp.status !== "PROCESSING") throw new Error("Import is not open");
  const list = await loadList(s.tenant.id, imp.listId);
  if (!list) throw new Error("Unknown list");

  const counts: BatchCounts = await intakeBatch({ tenantId: s.tenant.id, listId: list.id, source: "UPLOAD", requireConsentFields: false, actorId: s.user.id }, list, rows.slice(0, 2000));
  await prisma.listImport.update({
    where: { id: importId },
    data: {
      acceptedRows: { increment: counts.accepted },
      duplicateRows: { increment: counts.duplicate },
      badPhoneRows: { increment: counts.badPhone + counts.invalid },
      dncRows: { increment: counts.dnc },
    },
  });
  return counts;
}

export async function finishImport(importId: string, failed?: string): Promise<void> {
  const s = await requireRole("SUPERVISOR");
  const imp = await prisma.listImport.findFirst({ where: { id: importId, list: { tenantId: s.tenant.id } } });
  if (!imp) throw new Error("Unknown import");
  await prisma.listImport.update({
    where: { id: importId },
    data: { status: failed ? "FAILED" : "DONE", errorReason: failed ?? null, finishedAt: new Date() },
  });
  revalidatePath(`/lists/${imp.listId}`);
  revalidatePath("/lists");
}

export async function rememberedMappings(): Promise<Record<string, Record<string, string>>> {
  const s = await requireRole("SUPERVISOR");
  const settings = (s.tenant.settings ?? {}) as Record<string, unknown>;
  return (settings.importMappings as Record<string, Record<string, string>> | undefined) ?? {};
}
