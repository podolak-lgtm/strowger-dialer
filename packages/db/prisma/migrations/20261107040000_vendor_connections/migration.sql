-- CreateTable
CREATE TABLE "VendorConnection" (
    "vendor" TEXT NOT NULL,
    "sealed" TEXT,
    "hints" JSONB NOT NULL DEFAULT '{}',
    "nightly" BOOLEAN NOT NULL DEFAULT false,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastScreenshotKey" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorConnection_pkey" PRIMARY KEY ("vendor")
);

-- CreateTable
CREATE TABLE "VendorInvoice" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "origin" TEXT NOT NULL,
    "fileKey" TEXT,
    "fileType" TEXT,
    "totalCents" INTEGER,
    "currency" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorInvoice_vendor_period_idx" ON "VendorInvoice"("vendor", "period");

-- CreateIndex
CREATE UNIQUE INDEX "VendorInvoice_vendor_ref_key" ON "VendorInvoice"("vendor", "ref");

