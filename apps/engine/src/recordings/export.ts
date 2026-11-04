// Recordings cost money to keep. Nightly: push yesterday's recordings to the
// tenant's own SFTP server or Dropbox, then drop anything past the tenant's
// retention (default 60 days) unless it is on legal hold.
//
// Recording bytes come from jambonz (recent-calls recording endpoint) or from
// Call.recordingUrl when a direct URL is known. Until the jambonz account has
// a recording bucket, there is nothing to fetch and the job logs that.
import { prisma, type Tenant } from "@strowger/db";
import { decryptString } from "@strowger/shared/secrets";
import SftpClient from "ssh2-sftp-client";
import { config } from "../config";
import { log } from "../log";

export type ExportConfig =
  | { type: "sftp"; host: string; port?: number; username: string; password: string; path: string }
  | { type: "dropbox"; token: string; path: string };

function exportConfig(t: Tenant): ExportConfig | null {
  const raw = t.recordingExport as ExportConfig | null;
  if (!raw || typeof raw !== "object") return null;
  const secret = config.ENGINE_INTERNAL_KEY;
  if (raw.type === "sftp") return { ...raw, password: decryptString(raw.password, secret) ?? "" };
  if (raw.type === "dropbox") return { ...raw, token: decryptString(raw.token, secret) ?? "" };
  return null;
}

async function fetchRecording(call: { providerCallId: string | null; recordingUrl: string | null }): Promise<Buffer | null> {
  const candidates: Array<{ url: string; headers?: Record<string, string> }> = [];
  if (call.recordingUrl) candidates.push({ url: call.recordingUrl });
  if (call.providerCallId && config.JAMBONZ_API_KEY && config.JAMBONZ_ACCOUNT_SID) {
    candidates.push({ url: `${config.JAMBONZ_API_URL}/v1/Accounts/${config.JAMBONZ_ACCOUNT_SID}/RecentCalls/${call.providerCallId}/record`, headers: { authorization: `Bearer ${config.JAMBONZ_API_KEY}` } });
  }
  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { headers: c.headers, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* try the next */
    }
  }
  return null;
}

function fileName(call: { id: string; dialedAt: Date; phone: string; campaignId: string | null }): string {
  const d = call.dialedAt.toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return `${d}_${call.phone}_${call.id}.wav`;
}

async function uploadSftp(cfg: Extract<ExportConfig, { type: "sftp" }>, files: Array<{ name: string; data: Buffer; day: string }>): Promise<string[]> {
  const sftp = new SftpClient();
  const done: string[] = [];
  await sftp.connect({ host: cfg.host, port: cfg.port ?? 22, username: cfg.username, password: cfg.password, readyTimeout: 20_000 });
  try {
    for (const f of files) {
      const dir = `${cfg.path.replace(/\/$/, "")}/${f.day}`;
      await sftp.mkdir(dir, true).catch(() => undefined);
      await sftp.put(f.data, `${dir}/${f.name}`);
      done.push(`sftp://${cfg.host}${dir}/${f.name}`);
    }
  } finally {
    await sftp.end().catch(() => undefined);
  }
  return done;
}

async function uploadDropbox(cfg: Extract<ExportConfig, { type: "dropbox" }>, files: Array<{ name: string; data: Buffer; day: string }>): Promise<string[]> {
  const done: string[] = [];
  for (const f of files) {
    const path = `${cfg.path.replace(/\/$/, "")}/${f.day}/${f.name}`;
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/octet-stream", "dropbox-api-arg": JSON.stringify({ path, mode: "overwrite", mute: true }) },
      body: new Uint8Array(f.data),
    });
    if (!res.ok) throw new Error(`Dropbox ${res.status}: ${(await res.text()).slice(0, 200)}`);
    done.push(`dropbox:${path}`);
  }
  return done;
}

/** Export recordings not yet exported, oldest first, for one tenant. */
export async function exportTenantRecordings(tenant: Tenant, limit = 200): Promise<{ exported: number; missing: number; error?: string }> {
  const cfg = exportConfig(tenant);
  if (!cfg) return { exported: 0, missing: 0 };
  const calls = await prisma.call.findMany({
    where: { tenantId: tenant.id, recordingExportedTo: null, recordingDeletedAt: null, endedAt: { not: null }, bridgedAt: { not: null }, OR: [{ recordingUrl: { not: null } }, { providerCallId: { not: null } }] },
    orderBy: { dialedAt: "asc" },
    take: limit,
  });
  let exported = 0;
  let missing = 0;
  const batch: Array<{ callId: string; name: string; data: Buffer; day: string }> = [];
  for (const c of calls) {
    const data = await fetchRecording(c);
    if (!data) {
      missing++;
      continue;
    }
    batch.push({ callId: c.id, name: fileName(c), data, day: c.dialedAt.toISOString().slice(0, 10) });
  }
  if (batch.length === 0) return { exported: 0, missing };
  try {
    const dests = cfg.type === "sftp" ? await uploadSftp(cfg, batch) : await uploadDropbox(cfg, batch);
    for (const [i, b] of batch.entries()) {
      await prisma.call.update({ where: { id: b.callId }, data: { recordingExportedTo: dests[i] ?? null } });
      exported++;
    }
  } catch (e) {
    log.warn({ err: e, tenantId: tenant.id }, "recording export failed");
    return { exported, missing, error: e instanceof Error ? e.message : String(e) };
  }
  return { exported, missing };
}

/** Forget recordings past retention (not on legal hold). Deletion at jambonz follows when its API allows it. */
export async function sweepExpired(tenant: Tenant): Promise<number> {
  const cutoff = new Date(Date.now() - tenant.recordingRetentionDays * 86_400_000);
  const r = await prisma.call.updateMany({
    where: { tenantId: tenant.id, dialedAt: { lt: cutoff }, legalHold: false, recordingDeletedAt: null, OR: [{ recordingUrl: { not: null } }, { bridgedAt: { not: null } }] },
    data: { recordingDeletedAt: new Date(), recordingUrl: null },
  });
  return r.count;
}

export async function nightlyRecordings(): Promise<void> {
  const tenants = await prisma.tenant.findMany();
  for (const t of tenants) {
    const e = await exportTenantRecordings(t);
    const swept = await sweepExpired(t);
    if (e.exported || e.missing || swept || e.error) log.info({ tenantId: t.id, ...e, swept }, "nightly recordings");
  }
}
