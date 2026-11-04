-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "providerData" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sipSecret" TEXT;
