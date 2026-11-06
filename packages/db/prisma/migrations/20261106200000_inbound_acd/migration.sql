-- CreateEnum
CREATE TYPE "QueueStrategy" AS ENUM ('LONGEST_IDLE', 'ROUND_ROBIN', 'FEWEST_CALLS', 'MOST_SKILLED');

-- CreateEnum
CREATE TYPE "QueueCallbackStatus" AS ENUM ('WAITING', 'DIALING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "abandonedInQueue" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "queueId" TEXT,
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "surveyScore" INTEGER,
ADD COLUMN     "surveyStartedAt" TIMESTAMP(3),
ADD COLUMN     "waitSeconds" INTEGER,
ADD COLUMN     "wrapEndedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CallerIdNumber" ADD COLUMN     "scheduleId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "vip" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "agingSeconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "announce" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "announceEverySeconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "announcePosition" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "announceWait" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "blendWaitSeconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "callbackAudioId" TEXT,
ADD COLUMN     "callbackEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "callbackOfferAfterSeconds" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "fullAction" TEXT NOT NULL DEFAULT 'VOICEMAIL',
ADD COLUMN     "knownLeadPriority" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "maxWaiting" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reserveAgents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleId" TEXT,
ADD COLUMN     "slaSeconds" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "stickySeconds" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "strategy" "QueueStrategy" NOT NULL DEFAULT 'LONGEST_IDLE',
ADD COLUMN     "surveyAudioId" TEXT,
ADD COLUMN     "surveyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vipPriority" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "wrapUpSeconds" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "weekly" JSONB NOT NULL DEFAULT '{}',
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "closedNow" BOOLEAN NOT NULL DEFAULT false,
    "closedUntil" TIMESTAMP(3),
    "closedNowAudioId" TEXT,
    "closedAction" TEXT NOT NULL DEFAULT 'MESSAGE',
    "closedTargetId" TEXT,
    "closedGreetingAudioId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "numberId" TEXT,
    "ivrId" TEXT,
    "states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "areaCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetQueueId" TEXT NOT NULL,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueCallback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "leadId" TEXT,
    "callerId" TEXT NOT NULL,
    "originalCallId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" DOUBLE PRECISION NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" "QueueCallbackStatus" NOT NULL DEFAULT 'WAITING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "agentId" TEXT,
    "callId" TEXT,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "QueueCallback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_tenantId_name_key" ON "Schedule"("tenantId", "name");

-- CreateIndex
CREATE INDEX "GeoRoute_tenantId_idx" ON "GeoRoute"("tenantId");

-- CreateIndex
CREATE INDEX "GeoRoute_numberId_idx" ON "GeoRoute"("numberId");

-- CreateIndex
CREATE INDEX "GeoRoute_ivrId_idx" ON "GeoRoute"("ivrId");

-- CreateIndex
CREATE INDEX "QueueCallback_queueId_status_idx" ON "QueueCallback"("queueId", "status");

-- CreateIndex
CREATE INDEX "QueueCallback_tenantId_requestedAt_idx" ON "QueueCallback"("tenantId", "requestedAt");

-- CreateIndex
CREATE INDEX "Call_queueId_queuedAt_idx" ON "Call"("queueId", "queuedAt");

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoRoute" ADD CONSTRAINT "GeoRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoRoute" ADD CONSTRAINT "GeoRoute_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "CallerIdNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoRoute" ADD CONSTRAINT "GeoRoute_ivrId_fkey" FOREIGN KEY ("ivrId") REFERENCES "Ivr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoRoute" ADD CONSTRAINT "GeoRoute_targetQueueId_fkey" FOREIGN KEY ("targetQueueId") REFERENCES "Queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueCallback" ADD CONSTRAINT "QueueCallback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueCallback" ADD CONSTRAINT "QueueCallback_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueCallback" ADD CONSTRAINT "QueueCallback_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Queues that rank by skill today keep doing so: LONGEST_IDLE is the new default, MOST_SKILLED is the old ordering for skills queues.
UPDATE "Queue" SET "strategy" = 'MOST_SKILLED' WHERE "requiredSkills"::text NOT IN ('[]', 'null');
