-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN     "assistCallPriceMillicents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transcriptMinutePriceMillicents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "assistCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "complianceAlerts" JSONB,
ADD COLUMN     "sttAgentSeconds" INTEGER,
ADD COLUMN     "sttLeadSeconds" INTEGER,
ADD COLUMN     "suggestedDisposition" JSONB,
ADD COLUMN     "transcript" JSONB;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "assistMaxPerCall" INTEGER NOT NULL DEFAULT 40,
ADD COLUMN     "assistMinGapSeconds" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "assistModel" TEXT NOT NULL DEFAULT 'claude-haiku-5-5',
ADD COLUMN     "bannedPhrases" TEXT[] DEFAULT ARRAY['guaranteed', 'free', 'no cost', 'risk-free']::TEXT[],
ADD COLUMN     "disclosurePhrases" TEXT[] DEFAULT ARRAY['recorded', 'recording', 'quality and training', 'monitored', 'transcribed']::TEXT[],
ADD COLUMN     "liveAssistOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "postCallSummaryOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spokenDisclosureRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suggestDispositionOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcriptionOn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlatformRates" ADD COLUMN     "sttMinuteCostMillicents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "liveAssistOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcriptionOn" BOOLEAN NOT NULL DEFAULT false;

