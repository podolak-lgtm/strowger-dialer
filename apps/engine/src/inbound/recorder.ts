// Voicemail recorder: jambonz's `listen` verb streams the caller's audio to
// this WebSocket (first frame: JSON metadata, then L16 PCM at 8 kHz). On
// close we wrap it in a WAV header, store it in the media bucket and finish
// the Voicemail row.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@strowger/db";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { config } from "../config";
import { log } from "../log";
import { emitToAgent, emitToTenant } from "../realtime";
import { sendSms } from "../sms/provider";
import { formatPhone } from "@strowger/shared/phone";

/** Text the box owner that a voicemail landed, when both they and the campaign want it. */
async function alertAgent(tenantId: string, userId: string, callId: string | null, fromPhone: string, durationSec: number): Promise<void> {
  try {
    const [user, call] = await Promise.all([prisma.user.findFirst({ where: { id: userId, tenantId }, select: { mobilePhone: true, notifyVoicemailSms: true } }), callId ? prisma.call.findUnique({ where: { id: callId }, select: { campaignId: true, campaign: { select: { voicemailNotifySms: true } } } }) : null]);
    if (!user?.mobilePhone || !user.notifyVoicemailSms) return;
    if (call?.campaign && !call.campaign.voicemailNotifySms) return;
    const from = (await prisma.callerIdNumber.findFirst({ where: { tenantId, smsEnabled: true, status: "ACTIVE" }, select: { phone: true } }))?.phone;
    if (!from) return;
    await sendSms({ tenantId, campaignId: call?.campaignId ?? null, leadId: null, agentId: userId, from, to: user.mobilePhone, body: `Strowger: new voicemail from ${formatPhone(fromPhone)} (${durationSec}s). Listen at ${config.WEB_PUBLIC_URL}/voicemails`, purpose: "vm_alert" });
  } catch (e) {
    log.warn({ err: e, userId }, "voicemail alert text failed");
  }
}

const s3 = config.S3_ENDPOINT && config.S3_BUCKET ? new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION || "auto", forcePathStyle: true, credentials: { accessKeyId: config.S3_ACCESS_KEY_ID ?? "", secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? "" } }) : null;

function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function registerRecorder(app: FastifyInstance): Promise<void> {
  await app.register(websocket);
  app.get("/audio/voicemail", { websocket: true }, (socket, req) => {
    const vmId = (req.query as { vmId?: string }).vmId ?? "";
    const chunks: Buffer[] = [];
    let sampleRate = 8000;
    socket.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (!isBinary) {
        try {
          const meta = JSON.parse(data.toString()) as { sampleRate?: number };
          if (meta.sampleRate) sampleRate = meta.sampleRate;
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(Buffer.from(data));
    });
    socket.on("close", () => {
      void finish(vmId, Buffer.concat(chunks), sampleRate);
    });
  });
}

async function finish(vmId: string, pcm: Buffer, sampleRate: number): Promise<void> {
  const vm = await prisma.voicemail.findUnique({ where: { id: vmId }, include: { box: true } });
  if (!vm) return;
  const durationSec = Math.round(pcm.length / 2 / sampleRate);
  if (durationSec < 1) {
    await prisma.voicemail.delete({ where: { id: vmId } }).catch(() => undefined);
    return;
  }
  let recordingUrl: string | null = null;
  if (s3) {
    const key = `voicemail/${vm.tenantId}/${vmId}.wav`;
    try {
      await s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: wav(pcm, sampleRate), ContentType: "audio/wav" }));
      recordingUrl = `${config.WEB_PUBLIC_URL}/api/media/${key}`;
    } catch (e) {
      log.error({ err: e, vmId }, "voicemail upload failed");
    }
  } else {
    log.warn({ vmId }, "voicemail recorded but no media bucket configured on the engine");
  }
  await prisma.voicemail.update({ where: { id: vmId }, data: { durationSec, recordingUrl } });
  const payload = { voicemailId: vmId, boxId: vm.boxId, from: vm.fromPhone, durationSec };
  if (vm.box.ownerId) emitToAgent(vm.box.ownerId, "voicemail:new", payload);
  emitToTenant(vm.tenantId, "floor:voicemail", payload);
  if (vm.box.ownerId) void alertAgent(vm.tenantId, vm.box.ownerId, vm.callId, vm.fromPhone, durationSec);
}
