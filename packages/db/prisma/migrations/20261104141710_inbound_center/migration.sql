-- CreateEnum
CREATE TYPE "InboundRoute" AS ENUM ('CAMPAIGN', 'IVR', 'QUEUE', 'USER');

-- CreateEnum
CREATE TYPE "VoicemailStatus" AS ENUM ('NEW', 'LISTENED', 'DONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AudioKind" ADD VALUE 'IVR_GREETING';
ALTER TYPE "AudioKind" ADD VALUE 'VM_GREETING';

-- AlterTable
ALTER TABLE "CallerIdNumber" ADD COLUMN     "ivrId" TEXT,
ADD COLUMN     "queueId" TEXT,
ADD COLUMN     "routeTo" "InboundRoute" NOT NULL DEFAULT 'CAMPAIGN',
ADD COLUMN     "routeUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "extension" TEXT;

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("userId","skillId")
);

-- CreateTable
CREATE TABLE "Ivr" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "greetingAudioId" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "allowExtensions" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 6,
    "repeats" INTEGER NOT NULL DEFAULT 2,
    "timeoutAction" TEXT NOT NULL DEFAULT 'HANGUP',
    "timeoutTargetId" TEXT,

    CONSTRAINT "Ivr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Queue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiredSkills" JSONB NOT NULL DEFAULT '[]',
    "campaignId" TEXT,
    "holdAudioId" TEXT,
    "maxWaitSeconds" INTEGER NOT NULL DEFAULT 300,
    "overflowAction" TEXT NOT NULL DEFAULT 'VOICEMAIL',
    "overflowQueueId" TEXT,
    "voicemailBoxId" TEXT,

    CONSTRAINT "Queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoicemailBox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT,
    "greetingAudioId" TEXT,
    "notifyEmail" TEXT,

    CONSTRAINT "VoicemailBox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voicemail" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "callId" TEXT,
    "fromPhone" TEXT NOT NULL,
    "durationSec" INTEGER,
    "recordingUrl" TEXT,
    "transcript" TEXT,
    "status" "VoicemailStatus" NOT NULL DEFAULT 'NEW',
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voicemail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_name_key" ON "Skill"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Ivr_tenantId_name_key" ON "Ivr"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Queue_tenantId_name_key" ON "Queue"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "VoicemailBox_tenantId_name_key" ON "VoicemailBox"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Voicemail_tenantId_status_createdAt_idx" ON "Voicemail"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Voicemail_boxId_createdAt_idx" ON "Voicemail"("boxId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_extension_key" ON "User"("tenantId", "extension");

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_ivrId_fkey" FOREIGN KEY ("ivrId") REFERENCES "Ivr"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_routeUserId_fkey" FOREIGN KEY ("routeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ivr" ADD CONSTRAINT "Ivr_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_voicemailBoxId_fkey" FOREIGN KEY ("voicemailBoxId") REFERENCES "VoicemailBox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoicemailBox" ADD CONSTRAINT "VoicemailBox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoicemailBox" ADD CONSTRAINT "VoicemailBox_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voicemail" ADD CONSTRAINT "Voicemail_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voicemail" ADD CONSTRAINT "Voicemail_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "VoicemailBox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voicemail" ADD CONSTRAINT "Voicemail_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

