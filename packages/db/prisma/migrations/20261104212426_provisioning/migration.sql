-- AlterTable
ALTER TABLE "CallerIdNumber" ADD COLUMN     "jambonzPhoneNumberSid" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "provisionError" TEXT,
ADD COLUMN     "provisionStatus" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "telnyxNumberId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "jambonzCarrierSid" TEXT,
ADD COLUMN     "telnyxConnectionId" TEXT,
ADD COLUMN     "telnyxMessagingProfileId" TEXT,
ADD COLUMN     "telnyxOutboundProfileId" TEXT,
ADD COLUMN     "tenDlcBrand" JSONB,
ADD COLUMN     "tenDlcBrandId" TEXT,
ADD COLUMN     "tenDlcCampaign" JSONB,
ADD COLUMN     "tenDlcCampaignId" TEXT;

-- CreateTable
CREATE TABLE "NumberOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "areaCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "telnyxOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NumberOrder_tenantId_createdAt_idx" ON "NumberOrder"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "CallerIdNumber" ADD CONSTRAINT "CallerIdNumber_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "NumberOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberOrder" ADD CONSTRAINT "NumberOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberOrder" ADD CONSTRAINT "NumberOrder_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

