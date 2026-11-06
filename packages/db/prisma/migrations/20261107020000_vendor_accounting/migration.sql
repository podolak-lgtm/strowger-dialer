-- AlterTable
ALTER TABLE "PlatformRates" ADD COLUMN     "allocateUnattributed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "costAllocation" TEXT NOT NULL DEFAULT 'MINUTES',
ADD COLUMN     "marginFloorPct" INTEGER NOT NULL DEFAULT 40,
ADD COLUMN     "ttsCostMillicentsPerKChar" INTEGER NOT NULL DEFAULT 4000;

-- AlterTable
ALTER TABLE "VendorUsage" ADD COLUMN     "costMillicents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'usage',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "VendorFixedCost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "vendor" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'subscription',
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'MONTHLY',
    "startPeriod" TEXT NOT NULL,
    "endPeriod" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorFixedCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAccount" (
    "vendor" TEXT NOT NULL,
    "balanceCents" INTEGER,
    "balanceSource" TEXT,
    "balanceAt" TIMESTAMP(3),
    "lowBalanceCents" INTEGER,
    "usageSyncedAt" TIMESTAMP(3),
    "reportedPeriod" TEXT,
    "reportedCents" INTEGER,
    "reportedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAccount_pkey" PRIMARY KEY ("vendor")
);

-- CreateIndex
CREATE INDEX "VendorFixedCost_vendor_idx" ON "VendorFixedCost"("vendor");


-- Backfill (hand-written): every existing cost into the one cost model.
UPDATE "VendorUsage" SET "costMillicents" = "costCents" * 1000, "source" = CASE WHEN "vendor" = 'telnyx' THEN 'api' ELSE 'usage' END;

-- Calls and texts still at the rate (no Telnyx record matched yet): estimate rows, replaced when the record matches.
INSERT INTO "VendorUsage" ("id", "tenantId", "vendor", "kind", "quantity", "costCents", "costMillicents", "source", "day", "vendorRecordId", "refId", "createdAt", "updatedAt")
SELECT 'bf' || md5(be."id"), be."tenantId", 'telnyx', CASE WHEN be."category" = 'MINUTES' THEN 'sip-trunking' ELSE 'messaging' END, be."quantity", be."costCents", be."costCents" * 1000, 'estimate',
       to_char(be."createdAt", 'YYYY-MM-DD'), CASE WHEN be."category" = 'MINUTES' THEN 'est:call:' ELSE 'est:msg:' END || be."refId", be."refId", be."createdAt", be."createdAt"
FROM "BillingEntry" be
WHERE be."kind" = 'CHARGE' AND be."category" IN ('MINUTES', 'SMS') AND be."costSource" = 'rate' AND be."refId" IS NOT NULL
ON CONFLICT ("vendor", "vendorRecordId") DO NOTHING;

-- Number rental per number per month, to the client holding it.
INSERT INTO "VendorUsage" ("id", "tenantId", "vendor", "kind", "quantity", "costCents", "costMillicents", "source", "day", "vendorRecordId", "refId", "createdAt", "updatedAt")
SELECT 'bf' || md5(be."id"), be."tenantId", 'telnyx', 'number', 1, be."costCents", be."costCents" * 1000, 'usage', be."period" || '-01', 'did:' || be."refId" || ':' || be."period", be."refId", be."createdAt", be."createdAt"
FROM "BillingEntry" be
WHERE be."kind" = 'CHARGE' AND be."category" = 'DID' AND be."refId" IS NOT NULL
ON CONFLICT ("vendor", "vendorRecordId") DO NOTHING;

-- Litigator scrubs at the invoice rate.
INSERT INTO "VendorUsage" ("id", "tenantId", "vendor", "kind", "quantity", "costCents", "costMillicents", "source", "day", "vendorRecordId", "refId", "createdAt", "updatedAt")
SELECT 'bf' || md5(be."id"), be."tenantId", 'subscriberverify', 'scrub', be."quantity", be."costCents", be."costCents" * 1000, 'usage', to_char(be."createdAt", 'YYYY-MM-DD'), 'scrub:' || be."id", be."id", be."createdAt", be."createdAt"
FROM "BillingEntry" be
WHERE be."kind" = 'CHARGE' AND be."category" = 'SCRUB'
ON CONFLICT ("vendor", "vendorRecordId") DO NOTHING;

-- The Telnyx balance moves to VendorAccount (the PlatformRates columns are no longer written).
INSERT INTO "VendorAccount" ("vendor", "balanceCents", "balanceSource", "balanceAt", "lowBalanceCents", "usageSyncedAt", "updatedAt")
SELECT 'telnyx', "telnyxBalanceCents", CASE WHEN "telnyxBalanceCents" IS NULL THEN NULL ELSE 'api' END, "telnyxBalanceAt", 5000, "telnyxSyncedAt", CURRENT_TIMESTAMP FROM "PlatformRates" WHERE "id" = 'default'
ON CONFLICT ("vendor") DO NOTHING;

-- Placeholders for the costs with no API, so the owner only fills in amounts (0 = not counted).
INSERT INTO "VendorFixedCost" ("id", "vendor", "kind", "label", "amountCents", "cadence", "startPeriod", "updatedAt") VALUES
  ('fixed_jambonz_plan', 'jambonz', 'subscription', 'jambonz.cloud plan', 0, 'MONTHLY', '2026-11', CURRENT_TIMESTAMP),
  ('fixed_railway', 'railway', 'hosting', 'Railway: web, engine, Postgres, Redis', 0, 'MONTHLY', '2026-11', CURRENT_TIMESTAMP),
  ('fixed_clerk', 'clerk', 'auth', 'Clerk sign-in', 0, 'MONTHLY', '2026-11', CURRENT_TIMESTAMP),
  ('fixed_cartesia', 'cartesia', 'subscription', 'Cartesia plan (text to speech)', 0, 'MONTHLY', '2026-11', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
