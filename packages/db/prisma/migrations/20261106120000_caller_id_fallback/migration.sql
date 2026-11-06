-- CreateEnum
CREATE TYPE "CallerIdFallback" AS ENUM ('ANY', 'SAME_STATE', 'EXACT_ONLY');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "callerIdFallback" "CallerIdFallback" NOT NULL DEFAULT 'ANY';

