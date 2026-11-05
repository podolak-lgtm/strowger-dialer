-- CreateEnum
CREATE TYPE "PokerRunStatus" AS ENUM ('ACTIVE', 'ENDED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "betsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxStake" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "weeklyPoints" INTEGER NOT NULL DEFAULT 10000;

-- AlterTable
ALTER TABLE "PokerCard" ADD COLUMN     "runId" TEXT;

-- AlterTable
ALTER TABLE "Wager" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "PokerRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "prize" TEXT,
    "qualifies" TEXT NOT NULL DEFAULT 'SALE',
    "qualifyingCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PokerRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "winnerId" TEXT,
    "winningHand" JSONB,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PokerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PokerRun_tenantId_campaignId_status_idx" ON "PokerRun"("tenantId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "PokerCard_runId_userId_idx" ON "PokerCard"("runId", "userId");

-- CreateIndex
CREATE INDEX "Wager_tenantId_campaignId_status_idx" ON "Wager"("tenantId", "campaignId", "status");

-- AddForeignKey
ALTER TABLE "PokerRun" ADD CONSTRAINT "PokerRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerRun" ADD CONSTRAINT "PokerRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerRun" ADD CONSTRAINT "PokerRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerCard" ADD CONSTRAINT "PokerCard_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PokerRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Carry the workspace-wide games values (Tenant.settings.games) onto existing
-- campaigns. Bets stay off until an admin switches them on per campaign.
UPDATE "Campaign" c
SET "weeklyPoints" = GREATEST(0, LEAST(1000000, COALESCE((t.settings->'games'->>'weeklyPoints')::int, 10000))),
    "maxStake"     = GREATEST(1, LEAST(1000000, COALESCE((t.settings->'games'->>'maxStake')::int, 5000)))
FROM "Tenant" t
WHERE t.id = c."tenantId" AND t.settings->'games' IS NOT NULL;
