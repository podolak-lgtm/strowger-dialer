-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillingCategory" ADD VALUE 'TRIAL';
ALTER TYPE "BillingCategory" ADD VALUE 'REFERRAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillingKind" ADD VALUE 'TRIAL_CREDIT';
ALTER TYPE "BillingKind" ADD VALUE 'REFERRAL_CREDIT';
ALTER TYPE "BillingKind" ADD VALUE 'REFERRAL_CLAWBACK';

-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN     "suspendReason" TEXT;

-- AlterTable
ALTER TABLE "BillingEntry" ADD COLUMN     "uniqueKey" TEXT;

-- AlterTable
ALTER TABLE "PlatformRates" ADD COLUMN     "referralPct" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
ADD COLUMN     "trialAllowanceCents" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "trialDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "trialMaxNumbers" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "trialSeats" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "trialWithoutReferral" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "businessPhone" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referralPctOverride" DECIMAL(5,2),
ADD COLUMN     "referralTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "referralTermsAcceptedById" TEXT,
ADD COLUMN     "referralTermsVersion" TEXT,
ADD COLUMN     "referredByTenantId" TEXT,
ADD COLUMN     "trialAllowanceCents" INTEGER,
ADD COLUMN     "trialClosedAt" TIMESTAMP(3),
ADD COLUMN     "trialConvertedAt" TIMESTAMP(3),
ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "trialMaxNumbers" INTEGER,
ADD COLUMN     "trialReminderAt" TIMESTAMP(3),
ADD COLUMN     "trialSeats" INTEGER,
ADD COLUMN     "trialStartedAt" TIMESTAMP(3),
ADD COLUMN     "trialTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "trialTermsVersion" TEXT,
ADD COLUMN     "usageTermsAcceptedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referredTenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'link',
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralPayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "referredTenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pct" DECIMAL(5,2) NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "reason" TEXT,
    "clawbackBaseCents" INTEGER NOT NULL DEFAULT 0,
    "clawbackCents" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrialClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessKey" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredTenantId_key" ON "Referral"("referredTenantId");

-- CreateIndex
CREATE INDEX "Referral_tenantId_idx" ON "Referral"("tenantId");

-- CreateIndex
CREATE INDEX "ReferralPayout_tenantId_period_idx" ON "ReferralPayout"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralPayout_referralId_period_key" ON "ReferralPayout"("referralId", "period");

-- CreateIndex
CREATE INDEX "TrialClaim_businessKey_idx" ON "TrialClaim"("businessKey");

-- CreateIndex
CREATE INDEX "TrialClaim_phone_idx" ON "TrialClaim"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEntry_uniqueKey_key" ON "BillingEntry"("uniqueKey");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_referralCode_key" ON "Tenant"("referralCode");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredTenantId_fkey" FOREIGN KEY ("referredTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralPayout" ADD CONSTRAINT "ReferralPayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralPayout" ADD CONSTRAINT "ReferralPayout_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialClaim" ADD CONSTRAINT "TrialClaim_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

