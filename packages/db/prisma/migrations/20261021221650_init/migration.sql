-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('NONE', 'SCHEDULED', 'LOCKED', 'REVEALED', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "BetState" AS ENUM ('OPEN', 'WON', 'LOST', 'REFUND', 'PAID');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "address" TEXT NOT NULL,
    "userId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ageConfirmedAt" TIMESTAMP(3),
    "jurisdiction" TEXT,
    "kycReference" TEXT,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "short" TEXT NOT NULL,
    "kitHome" TEXT NOT NULL,
    "kitAway" TEXT NOT NULL,
    "formation" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "attrs" JSONB NOT NULL,
    "version" TEXT NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" BIGINT NOT NULL,
    "homeTeamId" INTEGER NOT NULL,
    "awayTeamId" INTEGER NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "fullTime" TIMESTAMP(3) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "engineVersion" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "rulesetHash" TEXT NOT NULL,
    "seedCommit" TEXT NOT NULL,
    "entropyBlock" BIGINT,
    "entropy" TEXT,
    "serverSeed" TEXT,
    "finalSeed" TEXT,
    "homeGoals" INTEGER,
    "awayGoals" INTEGER,
    "firstScorer" INTEGER,
    "resultHash" TEXT,
    "eventLogHash" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "bookSettled" BOOLEAN NOT NULL DEFAULT false,
    "createdTx" TEXT,
    "settledTx" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchConfig" (
    "matchId" BIGINT NOT NULL,
    "json" JSONB NOT NULL,

    CONSTRAINT "MatchConfig_pkey" PRIMARY KEY ("matchId")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "matchId" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tick" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "team" INTEGER NOT NULL,
    "player" INTEGER NOT NULL,
    "other" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "home" INTEGER NOT NULL,
    "away" INTEGER NOT NULL,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("matchId","seq")
);

-- CreateTable
CREATE TABLE "MatchReplay" (
    "matchId" BIGINT NOT NULL,
    "events" JSONB NOT NULL,

    CONSTRAINT "MatchReplay_pkey" PRIMARY KEY ("matchId")
);

-- CreateTable
CREATE TABLE "MatchStat" (
    "matchId" BIGINT NOT NULL,
    "team" INTEGER NOT NULL,
    "goals" INTEGER NOT NULL,
    "shots" INTEGER NOT NULL,
    "shotsOnTarget" INTEGER NOT NULL,
    "corners" INTEGER NOT NULL,
    "fouls" INTEGER NOT NULL,
    "saves" INTEGER NOT NULL,
    "passes" INTEGER NOT NULL,
    "passesCompleted" INTEGER NOT NULL,
    "tackles" INTEGER NOT NULL,
    "interceptions" INTEGER NOT NULL,
    "possession" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MatchStat_pkey" PRIMARY KEY ("matchId","team")
);

-- CreateTable
CREATE TABLE "BettingMarket" (
    "matchId" BIGINT NOT NULL,
    "selection" INTEGER NOT NULL,
    "market" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "won" BOOLEAN,

    CONSTRAINT "BettingMarket_pkey" PRIMARY KEY ("matchId","selection")
);

-- CreateTable
CREATE TABLE "OddsSnapshot" (
    "id" SERIAL NOT NULL,
    "matchId" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "odds" INTEGER[],
    "reason" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OddsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bet" (
    "id" BIGINT NOT NULL,
    "matchId" BIGINT NOT NULL,
    "bettor" TEXT NOT NULL,
    "selection" INTEGER NOT NULL,
    "stake" DECIMAL(38,0) NOT NULL,
    "odds" INTEGER NOT NULL,
    "payout" DECIMAL(38,0) NOT NULL,
    "state" "BetState" NOT NULL DEFAULT 'OPEN',
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetSettlement" (
    "betId" BIGINT NOT NULL,
    "won" BOOLEAN NOT NULL,
    "refund" BOOLEAN NOT NULL,
    "amountDue" DECIMAL(38,0) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetSettlement_pkey" PRIMARY KEY ("betId")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" SERIAL NOT NULL,
    "betId" BIGINT NOT NULL,
    "bettor" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "caller" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryTransaction" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "account" TEXT,
    "amount" DECIMAL(38,0) NOT NULL,
    "totalReservedAfter" DECIMAL(38,0),
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreasuryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorFeeReceipt" (
    "id" SERIAL NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "from" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorFeeReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenConversion" (
    "id" SERIAL NOT NULL,
    "ethIn" DECIMAL(38,0) NOT NULL,
    "usdgOut" DECIMAL(38,0) NOT NULL,
    "minOut" DECIMAL(38,0) NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasurySnapshot" (
    "id" SERIAL NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockNumber" BIGINT NOT NULL,
    "balance" DECIMAL(38,0) NOT NULL,
    "reserved" DECIMAL(38,0) NOT NULL,
    "totalStakes" DECIMAL(38,0) NOT NULL,
    "totalPayouts" DECIMAL(38,0) NOT NULL,
    "totalCreatorFees" DECIMAL(38,0) NOT NULL,
    "totalContributed" DECIMAL(38,0) NOT NULL,
    "totalWithdrawn" DECIMAL(38,0) NOT NULL,

    CONSTRAINT "TreasurySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulerJob" (
    "id" SERIAL NOT NULL,
    "matchId" BIGINT NOT NULL,
    "step" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "txHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchedulerJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockchainTransaction" (
    "hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "matchId" BIGINT,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "nonce" INTEGER,
    "status" TEXT NOT NULL,
    "gasUsed" BIGINT,
    "blockNumber" BIGINT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockchainTransaction_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "ContractEvent" (
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "contract" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractEvent_pkey" PRIMARY KEY ("txHash","logIndex")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL,
    "block" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,
    "chainTime" TIMESTAMP(3),
    "info" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" SERIAL NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNonce" (
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AdminNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" SERIAL NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_teamId_slot_version_key" ON "Player"("teamId", "slot", "version");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE INDEX "Match_kickoff_idx" ON "Match"("kickoff");

-- CreateIndex
CREATE INDEX "MatchEvent_matchId_type_idx" ON "MatchEvent"("matchId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "OddsSnapshot_matchId_version_key" ON "OddsSnapshot"("matchId", "version");

-- CreateIndex
CREATE INDEX "Bet_bettor_idx" ON "Bet"("bettor");

-- CreateIndex
CREATE INDEX "Bet_matchId_idx" ON "Bet"("matchId");

-- CreateIndex
CREATE INDEX "Bet_state_idx" ON "Bet"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Bet_txHash_logIndex_key" ON "Bet"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Claim_bettor_idx" ON "Claim"("bettor");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_txHash_logIndex_key" ON "Claim"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "TreasuryTransaction_kind_createdAt_idx" ON "TreasuryTransaction"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TreasuryTransaction_txHash_logIndex_key" ON "TreasuryTransaction"("txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorFeeReceipt_txHash_logIndex_key" ON "CreatorFeeReceipt"("txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "TokenConversion_txHash_logIndex_key" ON "TokenConversion"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "TreasurySnapshot_takenAt_idx" ON "TreasurySnapshot"("takenAt");

-- CreateIndex
CREATE INDEX "SchedulerJob_status_idx" ON "SchedulerJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulerJob_matchId_step_key" ON "SchedulerJob"("matchId", "step");

-- CreateIndex
CREATE INDEX "BlockchainTransaction_status_idx" ON "BlockchainTransaction"("status");

-- CreateIndex
CREATE INDEX "ContractEvent_name_blockNumber_idx" ON "ContractEvent"("name", "blockNumber");

-- CreateIndex
CREATE INDEX "Alert_resolved_createdAt_idx" ON "Alert"("resolved", "createdAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchConfig" ADD CONSTRAINT "MatchConfig_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchReplay" ADD CONSTRAINT "MatchReplay_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchStat" ADD CONSTRAINT "MatchStat_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BettingMarket" ADD CONSTRAINT "BettingMarket_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OddsSnapshot" ADD CONSTRAINT "OddsSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_bettor_fkey" FOREIGN KEY ("bettor") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetSettlement" ADD CONSTRAINT "BetSettlement_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_bettor_fkey" FOREIGN KEY ("bettor") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
