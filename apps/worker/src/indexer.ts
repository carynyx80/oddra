import { decodeEventLog, type Abi, type Address, type Log } from "viem";
import { db } from "@oddra/db";
import {
  oddraBookAbi,
  oddraFeeCollectorAbi,
  oddraMatchRegistryAbi,
  oddraTreasuryAbi,
  selectionWins,
} from "@oddra/shared";
import type { Chain } from "./chain";
import type { Env } from "./env";
import { log } from "./log";

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
    this.abis = {
      [d.book.toLowerCase()]: { name: "book", abi: oddraBookAbi as Abi },
      [d.registry.toLowerCase()]: { name: "registry", abi: oddraMatchRegistryAbi as Abi },
      [d.treasury.toLowerCase()]: { name: "treasury", abi: oddraTreasuryAbi as Abi },
      ...(d.feeCollector
        ? { [d.feeCollector.toLowerCase()]: { name: "feeCollector", abi: oddraFeeCollectorAbi as Abi } }
        : {}),
    };
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
        await this.treasuryRow("stake", null, bettor, a.stake, txHash, logIndex, blockNumber, createdAt);
        break;
      }
      case "book.BookSettled": {
        const mask = Number(a.winMask);
        const bets = await prisma.bet.findMany({
          where: { matchId: a.matchId },
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
          where: { matchId: a.matchId },
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
      create: { kind, source, account, amount: amount.toString(), txHash, logIndex, blockNumber, createdAt },
      update: {},
    });
  }

  /** Hourly-ish snapshot of the on-chain treasury totals for the charts. */
  async snapshot() {
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
    const [blockNumber, ...vals] = await Promise.all([
      this.chain.pub.getBlockNumber({ cacheTime: 0 }),
      ...fns.map(
        (fn) => this.chain.pub.readContract({ address: t, abi: oddraTreasuryAbi, functionName: fn }) as Promise<bigint>,
      ),
    ]);
    await prisma.treasurySnapshot.create({
      data: {
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

function decodeSource(b: string): string {
  const hex = b.replace(/^0x/, "").replace(/(00)+$/, "");
  return Buffer.from(hex, "hex").toString("utf8");
}
