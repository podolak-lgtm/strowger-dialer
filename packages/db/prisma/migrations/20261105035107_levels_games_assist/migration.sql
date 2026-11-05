-- CreateEnum
CREATE TYPE "WagerStatus" AS ENUM ('OPEN', 'ACCEPTED', 'SETTLED', 'DECLINED', 'VOID');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "rebuttals" JSONB,
ADD COLUMN     "voicemailNotifySms" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "mobilePhone" TEXT,
ADD COLUMN     "notifyVoicemailSms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "points" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Wager" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposerId" TEXT NOT NULL,
    "accepterId" TEXT,
    "kind" TEXT NOT NULL,
    "stake" INTEGER NOT NULL,
    "status" "WagerStatus" NOT NULL DEFAULT 'OPEN',
    "period" TEXT,
    "winnerId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Wager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "wagerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PokerCard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "card" TEXT NOT NULL,
    "callId" TEXT,
    "dealtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PokerCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Wager_tenantId_status_createdAt_idx" ON "Wager"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PointsLedger_tenantId_userId_createdAt_idx" ON "PointsLedger"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "PokerCard_tenantId_period_userId_idx" ON "PokerCard"("tenantId", "period", "userId");

-- AddForeignKey
ALTER TABLE "Wager" ADD CONSTRAINT "Wager_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wager" ADD CONSTRAINT "Wager_proposerId_fkey" FOREIGN KEY ("proposerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wager" ADD CONSTRAINT "Wager_accepterId_fkey" FOREIGN KEY ("accepterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsLedger" ADD CONSTRAINT "PointsLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsLedger" ADD CONSTRAINT "PointsLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerCard" ADD CONSTRAINT "PokerCard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerCard" ADD CONSTRAINT "PokerCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

