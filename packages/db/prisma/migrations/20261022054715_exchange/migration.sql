-- CreateTable
CREATE TABLE "ExchangeOffer" (
    "id" BIGINT NOT NULL,
    "matchId" BIGINT NOT NULL,
    "maker" TEXT NOT NULL,
    "selection" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "odds" INTEGER NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "refunded" DECIMAL(38,0),
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangePosition" (
    "id" BIGINT NOT NULL,
    "matchId" BIGINT NOT NULL,
    "offerId" BIGINT NOT NULL,
    "backer" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "selection" INTEGER NOT NULL,
    "odds" INTEGER NOT NULL,
    "asset" TEXT NOT NULL,
    "stake" DECIMAL(38,0) NOT NULL,
    "liability" DECIMAL(38,0) NOT NULL,
    "winner" TEXT,
    "paidAmount" DECIMAL(38,0),
    "fee" DECIMAL(38,0),
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangePosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeOffer_matchId_idx" ON "ExchangeOffer"("matchId");

-- CreateIndex
CREATE INDEX "ExchangeOffer_maker_idx" ON "ExchangeOffer"("maker");

-- CreateIndex
CREATE INDEX "ExchangePosition_matchId_idx" ON "ExchangePosition"("matchId");

-- CreateIndex
CREATE INDEX "ExchangePosition_backer_idx" ON "ExchangePosition"("backer");

-- CreateIndex
CREATE INDEX "ExchangePosition_layer_idx" ON "ExchangePosition"("layer");
