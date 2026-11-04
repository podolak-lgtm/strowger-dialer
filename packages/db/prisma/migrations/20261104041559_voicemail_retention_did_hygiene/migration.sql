-- CreateEnum
CREATE TYPE "VoicemailMode" AS ENUM ('FILE', 'TTS');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "recordingDeletedAt" TIMESTAMP(3),
ADD COLUMN     "recordingExportedTo" TEXT;

-- AlterTable
ALTER TABLE "CallerIdNumber" ADD COLUMN     "dailyCap" INTEGER,
ADD COLUMN     "firstUsedAt" TIMESTAMP(3),
ADD COLUMN     "registeredAt" TIMESTAMP(3),
ADD COLUMN     "restUntil" TIMESTAMP(3),
ADD COLUMN     "shortCallsToday" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "voicemailMode" "VoicemailMode" NOT NULL DEFAULT 'FILE',
ADD COLUMN     "voicemailRetryMinutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "voicemailScript" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "recordingExport" JSONB,
ALTER COLUMN "recordingRetentionDays" SET DEFAULT 60;

