-- CreateEnum
CREATE TYPE "ListSelection" AS ENUM ('STRICT_PRIORITY', 'WEIGHTED_ROUND_ROBIN');

-- CreateEnum
CREATE TYPE "CadenceKind" AS ENUM ('FRESH', 'AGED');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "listSelection" "ListSelection" NOT NULL DEFAULT 'STRICT_PRIORITY';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "assignedCallerId" TEXT,
ADD COLUMN     "callbackToken" TEXT,
ADD COLUMN     "lastAttemptDaypart" TEXT,
ADD COLUMN     "redialsCancelledOn" DATE;

-- AlterTable
ALTER TABLE "List" ADD COLUMN     "cadenceProfileId" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "error" TEXT,
ADD COLUMN     "purpose" TEXT;

-- CreateTable
CREATE TABLE "CadenceProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CadenceKind" NOT NULL DEFAULT 'AGED',
    "instantDial" BOOLEAN NOT NULL DEFAULT false,
    "instantDelaySeconds" INTEGER NOT NULL DEFAULT 5,
    "preCallSms" TEXT,
    "missedCallSms" TEXT,
    "maxAttemptsPerDay" INTEGER NOT NULL DEFAULT 3,
    "minGapMinutes" INTEGER NOT NULL DEFAULT 240,
    "rotateDayparts" BOOLEAN NOT NULL DEFAULT false,
    "dayparts" JSONB NOT NULL DEFAULT '{"MORNING":[8.5,11.5],"AFTERNOON":[12.5,16.5],"EVENING":[17,19.5]}',
    "cancelRedialsOnAnswer" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CadenceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CadenceProfile_tenantId_name_key" ON "CadenceProfile"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_callbackToken_key" ON "Lead"("callbackToken");

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_cadenceProfileId_fkey" FOREIGN KEY ("cadenceProfileId") REFERENCES "CadenceProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadenceProfile" ADD CONSTRAINT "CadenceProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

