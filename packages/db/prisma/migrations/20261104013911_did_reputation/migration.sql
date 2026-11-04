-- CreateEnum
CREATE TYPE "CarrierVerdict" AS ENUM ('GOOD', 'FLAGGED', 'SPAM', 'BLOCKED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "CallerIdNumber" ADD COLUMN     "attVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "attestation" TEXT,
ADD COLUMN     "autoRecheck" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "lastScannedAt" TIMESTAMP(3),
ADD COLUMN     "tmobileVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "verizonVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN';

-- CreateTable
CREATE TABLE "DidScan" (
    "id" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "attVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "verizonVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "tmobileVerdict" "CarrierVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "attestation" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DidScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DidScan_numberId_createdAt_idx" ON "DidScan"("numberId", "createdAt");

-- CreateIndex
CREATE INDEX "CallerIdNumber_tenantId_lastScannedAt_idx" ON "CallerIdNumber"("tenantId", "lastScannedAt");

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DidScan" ADD CONSTRAINT "DidScan_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "CallerIdNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
