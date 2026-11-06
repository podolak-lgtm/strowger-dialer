-- CreateEnum
CREATE TYPE "QueueAiMode" AS ENUM ('FIRST', 'OVERFLOW', 'ONLY');

-- CreateEnum
CREATE TYPE "AiOutcome" AS ENUM ('RESOLVED', 'HANDOFF', 'MESSAGE', 'CALLBACK', 'HANGUP');

-- AlterEnum
ALTER TYPE "BillingCategory" ADD VALUE 'AI';

-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN     "aiMinutePriceMillicents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "aiEndedAt" TIMESTAMP(3),
ADD COLUMN     "aiHandledAt" TIMESTAMP(3),
ADD COLUMN     "aiOutcome" "AiOutcome",
ADD COLUMN     "aiSeconds" INTEGER,
ADD COLUMN     "aiSummary" TEXT,
ADD COLUMN     "aiTranscript" JSONB;

-- AlterTable
ALTER TABLE "PlatformRates" ADD COLUMN     "aiMinuteCostMillicents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "aiAfterSeconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiGreeting" TEXT,
ADD COLUMN     "aiHandoffPhrases" TEXT[] DEFAULT ARRAY['operator', 'manager', 'supervisor', 'human', 'agent', 'representative', 'real person', 'speak to someone']::TEXT[],
ADD COLUMN     "aiInstructions" TEXT,
ADD COLUMN     "aiKnowledge" TEXT,
ADD COLUMN     "aiLanguage" TEXT NOT NULL DEFAULT 'en-US',
ADD COLUMN     "aiLlmVendor" TEXT NOT NULL DEFAULT 'anthropic',
ADD COLUMN     "aiMaxMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "aiMode" "QueueAiMode" NOT NULL DEFAULT 'FIRST',
ADD COLUMN     "aiModel" TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
ADD COLUMN     "aiSttVendor" TEXT,
ADD COLUMN     "aiTtsVendor" TEXT,
ADD COLUMN     "aiVoice" TEXT;

