-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "abandonedInForcedHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "forcedHoldSeconds" INTEGER;

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "minHoldBypassVip" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "minHoldSeconds" INTEGER NOT NULL DEFAULT 0;

