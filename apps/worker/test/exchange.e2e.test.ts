/**
 * Peer-to-peer exchange, full cycle, with real transactions and the worker's own modules:
 *
 *   Local:        E2E=1 DATABASE_URL=… npm test -w @oddra/worker -- exchange
 *   Mainnet fork: E2E=1 FORK_URL=https://rpc.mainnet.chain.robinhood.com DATABASE_URL=… npm test -w @oddra/worker -- exchange
 *
 * No house liquidity: bettors take each other's offers. On the fork, Paxos's real USDG contract is used and the
 * bettors are funded by impersonating an existing holder on the fork (no real funds move).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient, createWalletClient, defineChain, http, publicActions, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db } from "@oddra/db";
import { buildConfig, simulate } from "@oddra/engine";
import {
  ETH_ADDRESS,
  ST,
  oddraExchangeAbi,
  oddraMatchRegistryAbi,
  oddraTestUSDGAbi,
  selectionWins,
  slot,
  slotAt,
  winMask,
  type Deployment,
} from "@oddra/shared";
import { connect } from "../src/chain";
import type { Env } from "../src/env";
import { Indexer } from "../src/indexer";
import { Scheduler } from "../src/scheduler";

const RUN = process.env.E2E === "1";
const FORK = process.env.FORK_URL;
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const USDG_WHALE = (process.env.USDG_WHALE ?? "0x8366a39cc670b4001a1121b8f6a443a643e40951") as Address;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // anvil dev key
const ARBITER = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as Address;
// fresh keys: anvil's well-known accounts carry sweeper delegations on Robinhood mainnet
const [MAKER, TAKER, LONER] = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()] as Hex[];
const usdgAbi = oddraTestUSDGAbi;
const BACK = 0;
const LAY = 1;

describe.skipIf(!RUN)(`exchange cycle (${FORK ? "Robinhood mainnet fork, real USDG" : "local chain"})`, () => {
  let anvilProc: ChildProcess;
  let env: Env;
  let d: Deployment;
  let chain: ReturnType<typeof defineChain>;
  let test: ReturnType<typeof makeTest>;
  const makeTest = (c: ReturnType<typeof defineChain>) => createTestClient({ chain: c, mode: "anvil", transport: http(RPC) }).extend(publicActions);
  const wallet = (pk: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(pk) });
  const addr = (pk: Hex) => privateKeyToAccount(pk).address;

  async function warpTo(t: number) {
    const now = Number((await test.getBlock()).timestamp);
    if (t > now) await test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(t)) });
    await test.mine({ blocks: 1 });
  }
  async function send(hash: Hex) {
    expect((await test.waitForTransactionReceipt({ hash })).status).toBe("success");
  }

  beforeAll(async () => {
    anvilProc = spawn("anvil", ["--port", String(PORT), "--silent", ...(FORK ? ["--fork-url", FORK, "--chain-id", "31337"] : [])], {
      stdio: "ignore",
    });
    const probe = createTestClient({ mode: "anvil", transport: http(RPC) }).extend(publicActions);
    let chainId = 31337;
    for (let i = 0; i < 100; i++) {
      try {
        chainId = await probe.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    chain = defineChain({ id: chainId, name: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    test = makeTest(chain);
    const contracts = resolve(import.meta.dirname, "../../../contracts");
    execFileSync("./deploy.sh", [RPC], {
      cwd: contracts,
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: DEPLOYER,
        ARBITER_ADDRESS: ARBITER,
        MODE: "exchange",
        ...(FORK ? { USDG_ADDRESS: MAINNET_USDG, BLOCK_SOURCE: "fork", MAINNET_FORK: "true" } : {}),
      },
      stdio: "ignore",
    });
    d = JSON.parse(readFileSync(resolve(contracts, `deployments/${chainId}.json`), "utf8"));
    expect(d.mode).toBe("exchange");
    env = {
      chainId,
      rpcUrls: [RPC],
      operatorKey: DEPLOYER,
      keeperKey: DEPLOYER,
      seedSecret: `0x${"cd".repeat(32)}`,
      deployment: d,
      pricingSamples: 24,
      margin: 0.06,
      minFreeLiquidity: 0n,
      minFreeLiquidityEth: 0n,
      port: 0,
      tickMs: 0,
      instanceId: "e2e-x",
      alertWebhook: undefined,
    };
    await db().$executeRawUnsafe(
      `TRUNCATE "ExchangePosition", "ExchangeOffer", "Claim", "BetSettlement", "Bet", "OddsSnapshot", "BettingMarket", "MatchEvent", "MatchStat", "MatchReplay", "MatchConfig", "Match", "SchedulerJob", "BlockchainTransaction", "ContractEvent", "IndexerCursor", "Alert" CASCADE`,
    );
    for (const pk of [MAKER, TAKER, LONER]) await test.setBalance({ address: addr(pk), value: 10n ** 18n });
    if (FORK) {
      await test.impersonateAccount({ address: USDG_WHALE });
      await test.setBalance({ address: USDG_WHALE, value: 10n ** 18n });
      const whale = createWalletClient({ chain, transport: http(RPC), account: USDG_WHALE });
      for (const pk of [MAKER, TAKER, LONER])
        await send(await whale.writeContract({ address: d.usdg, abi: usdgAbi, functionName: "transfer", args: [addr(pk), 1_000n * 10n ** 6n] }));
    } else {
      for (const pk of [MAKER, TAKER, LONER]) await send(await wallet(pk).writeContract({ address: d.usdg, abi: usdgAbi, functionName: "faucet" }));
    }
    for (const pk of [MAKER, TAKER, LONER])
      await send(await wallet(pk).writeContract({ address: d.usdg, abi: usdgAbi, functionName: "approve", args: [d.exchange!, 2n ** 255n] }));
  }, 300_000);

  afterAll(() => anvilProc?.kill());

  it("matches back and lay offers in USDG and ETH, returns unmatched offers, settles after the dispute window and pays winners minus commission", async () => {
    const c = connect(env);
    const scheduler = new Scheduler(env, c);
    const indexer = new Indexer(env, c);
    const t0 = Number((await test.getBlock()).timestamp);
    const cur = slotAt(t0).matchId;
    const id = cur + 1n;
    const s = slot(id);
    await warpTo(slot(cur).openTime + 400);

    // the worker commits the match and publishes reference odds (a guide only)
    await scheduler.tick(true);
    await scheduler.tick(true);
    await scheduler.idle();
    await scheduler.tick(true);
    expect((await scheduler.readMatch(id)).status).toBe(ST.Scheduled);
    const ref = (await test.readContract({ address: d.exchange!, abi: oddraExchangeAbi, functionName: "referenceOdds", args: [id] })) as readonly number[];
    expect(ref[0]).toBeGreaterThan(100);

    await warpTo(s.openTime + 5);
    const X = d.exchange!;
    // 1. USDG: MAKER lays HOME at 2.50 for 40 USDG of backers' stake (escrows 60); TAKER backs 30 of it
    await send(await wallet(MAKER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "placeOffer", args: [id, 0, LAY, 250, 40_000_000n, d.usdg] }));
    await send(await wallet(TAKER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "take", args: [0n, 30_000_000n] }));
    // 2. ETH: MAKER backs DRAW at 3.40 with 0.01 ETH; TAKER lays all of it (liability 0.024 ETH)
    await send(await wallet(MAKER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "placeOffer", args: [id, 1, BACK, 340, 10n ** 16n, ETH_ADDRESS], value: 10n ** 16n }));
    await send(await wallet(TAKER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "take", args: [1n, 10n ** 16n], value: 24n * 10n ** 15n }));
    // 3. LONER posts an offer nobody takes
    await send(await wallet(LONER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "placeOffer", args: [id, 6, LAY, 190, 20_000_000n, d.usdg] }));
    expect(await test.readContract({ address: X, abi: oddraExchangeAbi, functionName: "positionCount" })).toBe(2n);

    // kickoff: no more taking; the unmatched remainders go back automatically
    await warpTo(s.kickoff);
    await expect(
      wallet(LONER).writeContract({ address: X, abi: oddraExchangeAbi, functionName: "take", args: [0n, 10_000_000n] }),
    ).rejects.toThrow();
    const loner0 = (await test.readContract({ address: d.usdg, abi: usdgAbi, functionName: "balanceOf", args: [addr(LONER)] })) as bigint;
    const maker0 = (await test.readContract({ address: d.usdg, abi: usdgAbi, functionName: "balanceOf", args: [addr(MAKER)] })) as bigint;
    await scheduler.tick(true); // lock + reclaim unmatched offers
    expect((await test.readContract({ address: d.usdg, abi: usdgAbi, functionName: "balanceOf", args: [addr(LONER)] })) - loner0).toBe(18_000_000n); // 20 × 0.90
    expect((await test.readContract({ address: d.usdg, abi: usdgAbi, functionName: "balanceOf", args: [addr(MAKER)] })) - maker0).toBe(15_000_000n); // 10 unmatched × 1.50

    // reveal, play, propose, dispute window, finalise
    await test.mine({ blocks: 6 });
    await scheduler.tick(true);
    let m = await scheduler.readMatch(id);
    expect(m.status).toBe(ST.Revealed);
    const r = simulate(buildConfig(id, m.homeTeam, m.awayTeam), m.finalSeed);
    await warpTo(s.fullTime + 1);
    await scheduler.tick(true);
    m = await scheduler.readMatch(id);
    expect(m.status).toBe(ST.Proposed);
    await warpTo(Number(m.proposedAt) + (await scheduler.disputeWindow()) + 1);
    await scheduler.tick(true); // finalize
    expect((await scheduler.readMatch(id)).status).toBe(ST.Settled);

    const first = r.firstScorer === "none" ? 0 : r.firstScorer === "home" ? 1 : 2;
    const mask = winMask(r.homeGoals, r.awayGoals, first);
    const homeWon = selectionWins(mask, 0);
    const drawWon = selectionWins(mask, 1);
    const usdgOf = (pk: Hex) => test.readContract({ address: d.usdg, abi: usdgAbi, functionName: "balanceOf", args: [addr(pk)] }) as Promise<bigint>;
    const before = { mu: await usdgOf(MAKER), tu: await usdgOf(TAKER), me: await test.getBalance({ address: addr(MAKER) }), te: await test.getBalance({ address: addr(TAKER) }) };
    await scheduler.tick(true); // payoutBatch for both positions
    const after = { mu: await usdgOf(MAKER), tu: await usdgOf(TAKER), me: await test.getBalance({ address: addr(MAKER) }), te: await test.getBalance({ address: addr(TAKER) }) };

    // USDG position: stake 30 (TAKER backs), liability 45 (MAKER lays), 2% commission on net winnings
    if (homeWon) expect(after.tu - before.tu).toBe(75_000_000n - 900_000n);
    else expect(after.mu - before.mu).toBe(75_000_000n - 600_000n);
    // ETH position: stake 0.01 (MAKER backs), liability 0.024 (TAKER lays)
    if (drawWon) expect(after.me - before.me).toBe(34n * 10n ** 15n - (24n * 10n ** 15n * 2n) / 100n);
    else expect(after.te - before.te).toBe(34n * 10n ** 15n - (10n ** 16n * 2n) / 100n);

    // nothing left in escrow; the exchange holds only its commission
    for (const asset of [d.usdg, ETH_ADDRESS])
      expect(await test.readContract({ address: X, abi: oddraExchangeAbi, functionName: "totalEscrowed", args: [asset] })).toBe(0n);

    await test.mine({ blocks: 3 });
    await indexer.run();
    expect(await db().exchangePosition.count({ where: { matchId: id } })).toBe(2);
    expect(await db().exchangeOffer.count({ where: { matchId: id, closed: true } })).toBe(3);
    expect(Number(await test.readContract({ address: d.registry, abi: oddraMatchRegistryAbi, functionName: "status", args: [id + 1n] }))).toBeGreaterThanOrEqual(ST.Scheduled);
  }, 600_000);
});
