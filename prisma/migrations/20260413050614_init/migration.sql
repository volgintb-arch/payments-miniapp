-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('EMPLOYEE', 'APPROVER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING_RETRO', 'MATCHED', 'NEEDS_REVIEW', 'ORPHANED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "telegramUsername" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserUnit" (
    "userId" TEXT NOT NULL,
    "unitId" INTEGER NOT NULL,

    CONSTRAINT "UserUnit_pkey" PRIMARY KEY ("userId","unitId")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "adeskLegalEntityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitGroup" (
    "unitId" INTEGER NOT NULL,
    "adeskGroupId" INTEGER NOT NULL,
    "adeskGroupName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UnitGroup_pkey" PRIMARY KEY ("unitId","adeskGroupId")
);

-- CreateTable
CREATE TABLE "UnitBankAccount" (
    "unitId" INTEGER NOT NULL,
    "adeskBankAccountId" INTEGER NOT NULL,

    CONSTRAINT "UnitBankAccount_pkey" PRIMARY KEY ("unitId","adeskBankAccountId")
);

-- CreateTable
CREATE TABLE "CategoryCache" (
    "adeskId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    "adeskGroupId" INTEGER,
    "adeskGroupName" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryCache_pkey" PRIMARY KEY ("adeskId")
);

-- CreateTable
CREATE TABLE "ContractorCache" (
    "adeskId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractorCache_pkey" PRIMARY KEY ("adeskId")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "unitId" INTEGER NOT NULL,
    "adeskCategoryId" INTEGER NOT NULL,
    "adeskContractorId" INTEGER,
    "contractorNameSnapshot" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT,
    "cardNote" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING_RETRO',
    "adeskConfirmedTransactionId" INTEGER,
    "retroAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastRetroAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchConflict" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "adeskTransactionId" INTEGER,
    "candidatePaymentIds" TEXT[],
    "candidateTransactionIds" INTEGER[],
    "resolvedByPaymentId" TEXT,
    "resolvedByTransactionId" INTEGER,
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MatchConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdeskApiLog" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "requestBody" JSONB,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdeskApiLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_name_key" ON "Unit"("name");

-- CreateIndex
CREATE INDEX "CategoryCache_adeskGroupId_idx" ON "CategoryCache"("adeskGroupId");

-- CreateIndex
CREATE INDEX "CategoryCache_type_isArchived_idx" ON "CategoryCache"("type", "isArchived");

-- CreateIndex
CREATE INDEX "ContractorCache_canonicalName_idx" ON "ContractorCache"("canonicalName");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_unitId_amount_date_idx" ON "Payment"("unitId", "amount", "date");

-- CreateIndex
CREATE INDEX "MatchConflict_resolvedAt_idx" ON "MatchConflict"("resolvedAt");

-- CreateIndex
CREATE INDEX "AdeskApiLog_createdAt_idx" ON "AdeskApiLog"("createdAt");

-- AddForeignKey
ALTER TABLE "UserUnit" ADD CONSTRAINT "UserUnit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserUnit" ADD CONSTRAINT "UserUnit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitGroup" ADD CONSTRAINT "UnitGroup_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitBankAccount" ADD CONSTRAINT "UnitBankAccount_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
