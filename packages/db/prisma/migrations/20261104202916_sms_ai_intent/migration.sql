-- AlterTable
ALTER TABLE "CadenceProfile" ALTER COLUMN "instantDelaySeconds" SET DEFAULT 15;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "intent" TEXT,
ADD COLUMN     "intentConfidence" DOUBLE PRECISION,
ADD COLUMN     "intentReason" TEXT;

