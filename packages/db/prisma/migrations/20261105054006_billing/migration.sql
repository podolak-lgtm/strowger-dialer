-- CreateEnum
CREATE TYPE "BillingKind" AS ENUM ('CHARGE', 'PAYMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BillingCategory" AS ENUM ('SEAT', 'MINUTES', 'DID', 'SCRUB', 'SMS', 'OTHER', 'PAYMENT');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "isPlatform" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "seatMonthlyCents" INTEGER NOT NULL DEFAULT 7000,
    "perMinuteMillicents" INTEGER NOT NULL DEFAULT 1200,
    "didMarkupPct" INTEGER NOT NULL DEFAULT 50,
    "scrubMarginMillicents" INTEGER NOT NULL DEFAULT 500,
    "smsPriceMillicents" INTEGER NOT NULL DEFAULT 1500,
    "lowBalanceCents" INTEGER NOT NULL DEFAULT 20000,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "zeroSince" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "BillingKind" NOT NULL,
    "category" "BillingCategory" NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "unitMillicents" INTEGER NOT NULL DEFAULT 0,
    "amountCents" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "refId" TEXT,
    "period" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformRates" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "telnyxOutMillicentsPerMin" INTEGER NOT NULL DEFAULT 500,
    "telnyxInMillicentsPerMin" INTEGER NOT NULL DEFAULT 320,
    "didMonthlyCents" INTEGER NOT NULL DEFAULT 110,
    "scrubCostMillicents" INTEGER NOT NULL DEFAULT 500,
    "smsCostMillicents" INTEGER NOT NULL DEFAULT 400,
    "prepayInstructions" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformRates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_tenantId_key" ON "BillingAccount"("tenantId");

-- CreateIndex
CREATE INDEX "BillingEntry_tenantId_period_category_idx" ON "BillingEntry"("tenantId", "period", "category");

-- CreateIndex
CREATE INDEX "BillingEntry_tenantId_createdAt_idx" ON "BillingEntry"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The first workspace created is the owner's platform workspace.
UPDATE "Tenant" SET "isPlatform" = true WHERE id = (SELECT id FROM "Tenant" ORDER BY "createdAt" ASC LIMIT 1);
INSERT INTO "PlatformRates" (id, "updatedAt") VALUES ('default', NOW()) ON CONFLICT DO NOTHING;
