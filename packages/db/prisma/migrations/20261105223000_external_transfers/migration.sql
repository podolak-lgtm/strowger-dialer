-- CreateEnum
CREATE TYPE "TransferOutcome" AS ENUM ('ANSWERED', 'NO_ANSWER', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransferCallerIdMode" AS ENUM ('CUSTOMER', 'STATIC');

-- AlterEnum
ALTER TYPE "CallDirection" ADD VALUE 'TRANSFER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadEventKind" ADD VALUE 'TRANSFER_STARTED';
ALTER TYPE "LeadEventKind" ADD VALUE 'TRANSFER_ANSWERED';
ALTER TYPE "LeadEventKind" ADD VALUE 'TRANSFER_NO_ANSWER';
ALTER TYPE "LeadEventKind" ADD VALUE 'TRANSFER_CANCELLED';
ALTER TYPE "LeadEventKind" ADD VALUE 'AGENT_LEFT';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "destinationId" TEXT,
ADD COLUMN     "parentCallId" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "agentLeftAt" TIMESTAMP(3),
ADD COLUMN     "answeredAt" TIMESTAMP(3),
ADD COLUMN     "callerIdFallback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "callerIdShown" TEXT,
ADD COLUMN     "destinationCallId" TEXT,
ADD COLUMN     "destinationId" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "outcome" "TransferOutcome";

-- CreateTable
CREATE TABLE "TransferDestination" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "type" "TransferKind" NOT NULL DEFAULT 'COLD',
    "callerIdMode" "TransferCallerIdMode" NOT NULL DEFAULT 'CUSTOMER',
    "staticCallerId" TEXT,
    "whisperOn" BOOLEAN NOT NULL DEFAULT true,
    "whisperText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferDestination_campaignId_sortOrder_idx" ON "TransferDestination"("campaignId", "sortOrder");

-- CreateIndex
CREATE INDEX "Transfer_callId_idx" ON "Transfer"("callId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_parentCallId_fkey" FOREIGN KEY ("parentCallId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "TransferDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferDestination" ADD CONSTRAINT "TransferDestination_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferDestination" ADD CONSTRAINT "TransferDestination_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "TransferDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

