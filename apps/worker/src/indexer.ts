import { decodeEventLog, type Abi, type Address, type Log } from "viem";
import { db } from "@oddra/db";
import {
  oddraBookAbi,
  oddraFeeCollectorAbi,
  oddraMatchRegistryAbi,
  oddraTreasuryAbi,
  ETH_ADDRESS,
  isEth,
  oddraExchangeAbi,
  ST,
  selectionWins,
} from "@oddra/shared";
import type { Chain } from "./chain";
import type { Env } from "./env";
import { log } from "./log";

const ZERO = "0x0000000000000000000000000000000000000000";

const STEP = 2_000n;
const CONFIRMATIONS = 2n;

/**
 * Copies contract events into Postgres. Idempotent: every row is keyed by (txHash, logIndex), and the cursor only
 * advances after a range is fully written, so a crash just re-reads the same range.
 */
export class Indexer {
  private readonly abis: Record<string, { name: string; abi: Abi }>;
  private readonly blockTimes = new Map<bigint, Date>();

  constructor(
    private readonly env: Env,
    private readonly chain: Chain,
  ) {
    const d = env.deployment;
    const entries: [Address | undefined, string, Abi][] = [
      [d.book, "book", oddraBookAbi as Abi],
      [d.registry, "registry", oddraMatchRegistryAbi as Abi],
      [d.exchange, "exchange", oddraExchangeAbi as Abi],
      [d.treasury, "treasury", oddraTreasuryAbi as Abi],
      [d.feeCollector, "feeCollector", oddraFeeCollectorAbi as Abi],
    ];
    this.abis = Object.fromEntries(
      entries.filter(([a]) => a && a !== ZERO).map(([a, name, abi]) => [a!.toLowerCase(), { name, abi }]),
    );
  }

  async run(): Promise<bigint> {
    const prisma = db();
    const head = (await this.chain.pub.getBlockNumber({ cacheTime: 0 })) - CONFIRMATIONS;
    const cur = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
    let from = cur ? cur.block + 1n : BigInt(this.env.deployment.deployedAtBlock);
    let processed = 0;
    while (from <= head && processed < 10) {
      const to = from + STEP - 1n > head ? head : from + STEP - 1n;
      const logs = await this.chain.pub.getLogs({
        address: Object.keys(this.abis) as Address[],
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) await this.handle(l);
      await prisma.indexerCursor.upsert({
        where: { id: "main" },
        create: { id: "main", block: to },
        update: { block: to },
      });
      if (logs.length) log.info("indexed", { from, to, logs: logs.length });
      from = to + 1n;
      processed++;
    }
    return head;
  }

  private async time(block: bigint): Promise<Date> {
    let t = this.blockTimes.get(block);
    if (!t) {
      const b = await this.chain.pub.getBlock({ blockNumber: block });
      t = new Date(Number(b.timestamp) * 1000);
      this.blockTimes.set(block, t);
      if (this.blockTimes.size > 5_000) this.blockTimes.clear();
    }
    return t;
  }

  private async handle(l: Log) {
    const src = this.abis[l.address.toLowerCase()];
    if (!src || l.transactionHash == null || l.logIndex == null || l.blockNumber == null) return;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: src.abi, data: l.data, topics: l.topics }) as never;
    } catch {
      return; // role-admin events etc. that the ABIs share; nothing to index
    }
    const prisma = db();
    const txHash = l.transactionHash;
    const logIndex = l.logIndex;
    const blockNumber = l.blockNumber;
    const createdAt = await this.time(blockNumber);
    const a = ev.args as Record<string, any>;
    await prisma.contractEvent.upsert({
      where: { txHash_logIndex: { txHash, logIndex } },
      create: {
        txHash,
        logIndex,
        blockNumber,
        contract: src.name,
        name: ev.eventName,
        args: JSON.parse(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
        createdAt,
      },
      update: {},
    });

    switch (`${src.name}.${ev.eventName}`) {
      case "book.BetPlaced": {
        const bettor = (a.bettor as string).toLowerCase();
        await prisma.wallet.upsert({
          where: { address: bettor },
          create: { address: bettor },
          update: { lastSeenAt: createdAt },
        });
        await prisma.bet.upsert({
          where: { id: a.betId },
          create: {
            id: a.betId,
            matchId: a.matchId,
            bettor,
            selection: Number(a.selection),
            asset: assetKey(a.asset),
            stake: a.stake.toString(),
            odds: Number(a.odds),
            payout: a.payout.toString(),
            txHash,
            logIndex,
            blockNumber,
            placedAt: createdAt,
          },
          update: {},
        });
        await this.treasuryRow(
          "stake",
          assetKey(a.asset),
          null,
          bettor,
          a.stake,
          txHash,
          logIndex,
          blockNumber,
          createdAt,
        );
        break;
      }
      case "book.BookSettled": {
        const mask = Number(a.winMask);
        const bets = await prisma.bet.findMany({
          where: { matchId: a.matchId, asset: assetKey(a.asset) },
          select: { id: true, selection: true, payout: true, state: true },
        });
        for (const b of bets) {
          const won = selectionWins(mask, b.selection);
          await prisma.betSettlement.upsert({
            where: { betId: b.id },
            create: { betId: b.id, won, refund: false, amountDue: won ? b.payout : "0" },
            update: {},
          });
          if (b.state === "OPEN")
            await prisma.bet.update({ where: { id: b.id }, data: { state: won ? "WON" : "LOST" } });
        }
        break;
      }
      case "book.BookVoided": {
        const bets = await prisma.bet.findMany({
          where: { matchId: a.matchId, asset: assetKey(a.asset) },
          select: { id: true, stake: true, state: true },
        });
        for (const b of bets) {
          await prisma.betSettlement.upsert({
            where: { betId: b.id },
            create: { betId: b.id, won: false, refund: true, amountDue: b.stake },
            update: {},
          });
          if (b.state === "OPEN") await prisma.bet.update({ where: { id: b.id }, data: { state: "REFUND" } });
        }
        break;
      }
      case "book.Claimed": {
        const bettor = (a.bettor as string).toLowerCase();
        await prisma.wallet.upsert({ where: { address: bettor }, create: { address: bettor }, update: {} });
        const bet = await prisma.bet.findUnique({ where: { id: a.betId }, select: { id: true } });
        if (bet) {
          await prisma.claim.upsert({
            where: { txHash_logIndex: { txHash, logIndex } },
            create: {
              betId: a.betId,
              bettor,
              asset: assetKey(a.asset),
              amount: a.amount.toString(),
              caller: (a.caller as string).toLowerCase(),
              automatic: (a.caller as string).toLowerCase() !== bettor,
              txHash,
              logIndex,
              blockNumber,
              createdAt,
            },
            update: {},
          });
          await prisma.bet.update({ where: { id: a.betId }, data: { state: "PAID" } });
        }
        break;
      }
      case "book.PayoutFailed":
        await prisma.alert.create({
          data: {
            level: "warn",
            source: "payouts",
            message: `Automatic payout of bet ${a.betId} failed; it stays claimable.`,
          },
        });
        break;
      case "treasury.Contributed":
        await this.treasuryRow(
          "contribution",
          assetKey(a.asset),
          decodeSource(a.source),
          (a.from as string).toLowerCase(),
          a.amount,
          txHash,
          logIndex,
          blockNumber,
          createdAt,
        );
        break;
      case "treasury.Paid":
        await this.treasuryRow(
          "payout",
          assetKey(a.asset),
          null,
          (a.to as string).toLowerCase(),
          a.amount,
          txHash,
          logIndex,
          blockNumber,
          createdAt,
        );
        break;
      case "treasury.Withdrawn":
        await this.treasuryRow(
          "withdrawal",
          assetKey(a.asset),
          null,
          (a.to as string).toLowerCase(),
          a.amount,
          txHash,
          logIndex,
          blockNumber,
          createdAt,
        );
        break;
      case "feeCollector.EthReceived":
        await prisma.creatorFeeReceipt.upsert({
          where: { txHash_logIndex: { txHash, logIndex } },
          create: {
            asset: "ETH",
            amount: a.amount.toString(),
            from: (a.from as string).toLowerCase(),
            txHash,
            logIndex,
            blockNumber,
            createdAt,
          },
          update: {},
        });
        break;
      case "feeCollector.Forwarded":
        await prisma.creatorFeeReceipt.upsert({
          where: { txHash_logIndex: { txHash, logIndex } },
          create: { asset: "USDG", amount: a.amount.toString(), from: null, txHash, logIndex, blockNumber, createdAt },
          update: {},
        });
        break;
      case "exchange.OfferPlaced":
        await prisma.exchangeOffer.upsert({
          where: { id: a.offerId },
          create: {
            id: a.offerId,
            matchId: a.matchId,
            maker: (a.maker as string).toLowerCase(),
            selection: Number(a.selection),
            side: Number(a.side) === 0 ? "BACK" : "LAY",
            odds: Number(a.odds),
            asset: assetKey(a.asset),
            amount: a.amount.toString(),
            txHash,
            createdAt,
          },
          update: {},
        });
        break;
      case "exchange.OfferClosed":
        await prisma.exchangeOffer.updateMany({
          where: { id: a.offerId },
          data: { closed: true, refunded: a.refunded.toString() },
        });
        break;
      case "exchange.Matched": {
        for (const who of [a.backer, a.layer] as string[]) {
          const w = who.toLowerCase();
          await prisma.wallet.upsert({
            where: { address: w },
            create: { address: w },
            update: { lastSeenAt: createdAt },
          });
        }
        await prisma.exchangePosition.upsert({
          where: { id: a.positionId },
          create: {
            id: a.positionId,
            matchId: a.matchId,
            offerId: a.offerId,
            backer: (a.backer as string).toLowerCase(),
            layer: (a.layer as string).toLowerCase(),
            selection: Number(a.selection),
            odds: Number(a.odds),
            asset: assetKey(a.asset),
            stake: a.stake.toString(),
            liability: a.liability.toString(),
            txHash,
            createdAt,
          },
          update: {},
        });
        break;
      }
      case "exchange.Paid": {
        // a void pays both sides back; otherwise the paid side is the winner (a tiny win can round to zero fee)
        const pos = await prisma.exchangePosition.findUnique({ where: { id: a.positionId } });
        const st = pos
          ? Number(
              await this.chain.pub.readContract({
                address: this.env.deployment.registry,
                abi: oddraMatchRegistryAbi,
                functionName: "status",
                args: [pos.matchId],
              }),
            )
          : 0;
        const winner = st === ST.Voided ? "VOID" : Number(a.side) === 0 ? "BACK" : "LAY";
        const paid = BigInt(a.amount) + (pos?.paidAmount && winner === "VOID" ? BigInt(pos.paidAmount.toFixed()) : 0n);
        await prisma.exchangePosition.updateMany({
          where: { id: a.positionId },
          data: { winner, paidAmount: paid.toString(), fee: a.fee.toString() },
        });
        break;
      }
      case "exchange.PayoutFailed":
        await prisma.alert.create({
          data: {
            level: "warn",
            source: "payouts",
            message: `Exchange payout for position ${a.positionId} failed; it stays claimable.`,
          },
        });
        break;
      case "feeCollector.ForwardedETH":
        await prisma.creatorFeeReceipt.upsert({
          where: { txHash_logIndex: { txHash, logIndex } },
          create: {
            asset: "ETH_TO_TREASURY",
            amount: a.amount.toString(),
            from: null,
            txHash,
            logIndex,
            blockNumber,
            createdAt,
          },
          update: {},
        });
        break;
      case "registry.ResultDisputed":
        await prisma.alert.create({
          data: {
            level: "critical",
            source: "disputes",
            message: `The result of match ${a.matchId} was disputed by ${a.disputer}. The arbiter must rule within 24 hours or the match is voided.`,
          },
        });
        break;
      case "feeCollector.Converted":
        await prisma.tokenConversion.upsert({
          where: { txHash_logIndex: { txHash, logIndex } },
          create: {
            ethIn: a.ethIn.toString(),
            usdgOut: a.usdgOut.toString(),
            minOut: a.minOut.toString(),
            txHash,
            logIndex,
            blockNumber,
            createdAt,
          },
          update: {},
        });
        break;
    }
  }

  private async treasuryRow(
    kind: string,
    asset: string,
    source: string | null,
    account: string | null,
    amount: bigint,
    txHash: string,
    logIndex: number,
    blockNumber: bigint,
    createdAt: Date,
  ) {
    await db().treasuryTransaction.upsert({
      where: { txHash_logIndex: { txHash, logIndex } },
      create: { kind, asset, source, account, amount: amount.toString(), txHash, logIndex, blockNumber, createdAt },
      update: {},
    });
  }

  /** Snapshot of the on-chain treasury totals for each asset, every 10 minutes, for the charts. */
  async snapshot() {
    if (this.env.deployment.mode === "exchange") return; // no house treasury
    const prisma = db();
    const last = await prisma.treasurySnapshot.findFirst({ orderBy: { takenAt: "desc" } });
    if (last && Date.now() - last.takenAt.getTime() < 10 * 60_000) return;
    const t = this.env.deployment.treasury;
    const fns = [
      "balance",
      "totalReserved",
      "totalStakes",
      "totalPayouts",
      "totalCreatorFees",
      "totalContributed",
      "totalWithdrawn",
    ] as const;
    const blockNumber = await this.chain.pub.getBlockNumber({ cacheTime: 0 });
    for (const [key, address] of [
      ["USDG", this.env.deployment.usdg],
      ["ETH", ETH_ADDRESS],
    ] as const) {
      const vals = await Promise.all(
        fns.map(
          (fn) =>
            this.chain.pub.readContract({
              address: t,
              abi: oddraTreasuryAbi,
              functionName: fn,
              args: [address],
            }) as Promise<bigint>,
        ),
      );
      await prisma.treasurySnapshot.create({
        data: {
          asset: key,
          blockNumber,
          balance: vals[0].toString(),
          reserved: vals[1].toString(),
          totalStakes: vals[2].toString(),
          totalPayouts: vals[3].toString(),
          totalCreatorFees: vals[4].toString(),
          totalContributed: vals[5].toString(),
          totalWithdrawn: vals[6].toString(),
        },
      });
    }
  }
}

const assetKey = (a: unknown) => (isEth(String(a)) ? "ETH" : "USDG");

function decodeSource(b: string): string {
  const hex = b.replace(/^0x/, "").replace(/(00)+$/, "");
  return Buffer.from(hex, "hex").toString("utf8");
}
