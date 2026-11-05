-- AlterTable
ALTER TABLE "BillingEntry" ADD COLUMN     "costSource" TEXT NOT NULL DEFAULT 'rate';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "vendorCostCents" INTEGER,
ADD COLUMN     "vendorRecordId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "vendorCostCents" INTEGER;

-- AlterTable
ALTER TABLE "PlatformRates" ADD COLUMN     "telnyxBalanceAt" TIMESTAMP(3),
ADD COLUMN     "telnyxBalanceCents" INTEGER,
ADD COLUMN     "telnyxSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VendorUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "vendor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "costCents" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "vendorRecordId" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorUsage_vendor_day_idx" ON "VendorUsage"("vendor", "day");

-- CreateIndex
CREATE INDEX "VendorUsage_tenantId_day_idx" ON "VendorUsage"("tenantId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "VendorUsage_vendor_vendorRecordId_key" ON "VendorUsage"("vendor", "vendorRecordId");

