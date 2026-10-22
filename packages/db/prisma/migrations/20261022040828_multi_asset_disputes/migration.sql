-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MatchStatus" ADD VALUE 'PROPOSED';
ALTER TYPE "MatchStatus" ADD VALUE 'DISPUTED';

-- DropIndex
DROP INDEX "TreasurySnapshot_takenAt_idx";

-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "asset" TEXT NOT NULL DEFAULT 'USDG';

-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "asset" TEXT NOT NULL DEFAULT 'USDG';

-- AlterTable
ALTER TABLE "TreasurySnapshot" ADD COLUMN     "asset" TEXT NOT NULL DEFAULT 'USDG';

-- AlterTable
ALTER TABLE "TreasuryTransaction" ADD COLUMN     "asset" TEXT NOT NULL DEFAULT 'USDG';

-- CreateIndex
CREATE INDEX "TreasurySnapshot_asset_takenAt_idx" ON "TreasurySnapshot"("asset", "takenAt");
