/**
 * Full match cycle with real transactions and a real Postgres, using the worker's own modules. Nothing is mocked:
 * time moves only by advancing the chain's clock.
 *
 *   Local:        E2E=1 DATABASE_URL=… npm test -w @oddra/worker
 *   Mainnet fork: E2E=1 FORK_URL=https://rpc.mainnet.chain.robinhood.com DATABASE_URL=… npm test -w @oddra/worker
 *
 * The fork run deploys against Robinhood Chain mainnet state, with Paxos's real USDG contract, and funds the test
 * bettors by impersonating an existing USDG holder on the fork (no real funds move).
 * Needs `anvil` and `forge` on PATH and DATABASE_URL pointing at a migrated database.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient, createWalletClient, defineChain, http, publicActions, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db } from "@oddra/db";
import { buildConfig, configHash, resultHash, simulate } from "@oddra/engine";
import {
  ETH_ADDRESS,
  ST,
  oddraBookAbi,
  oddraMatchRegistryAbi,
  oddraTestUSDGAbi,
  oddraTreasuryAbi,
  slot,
  slotAt,
  type Deployment,
} from "@oddra/shared";
import { connect } from "../src/chain";
import type { Env } from "../src/env";
import { Indexer } from "../src/indexer";
import { Scheduler } from "../src/scheduler";

const RUN = process.env.E2E === "1";
const FORK = process.env.FORK_URL;
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const MAINNET_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
/** An existing large USDG holder on Robinhood Chain mainnet, impersonated on the fork only. */
const USDG_WHALE = (process.env.USDG_WHALE ?? "0x8366a39cc670b4001a1121b8f6a443a643e40951") as Address;
// anvil's published development keys (local chain / fork only)
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ARBITER = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as Address;
// Fresh keys every run: anvil's well-known accounts carry EIP-7702 sweeper delegations on Robinhood mainnet, which
// refuse plain ETH transfers (a real-world case the book handles: the payout fails and the bet stays claimable).
const BETTORS = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey(), generatePrivateKey()] as Hex[];
const usdgAbi = oddraTestUSDGAbi; // the ERC-20 functions used here are identical
const HOUSE = "0x686f757365000000000000000000000000000000000000000000000000000000" as Hex; // "house"

describe.skipIf(!RUN)(`full match cycle (${FORK ? "Robinhood mainnet fork, real USDG" : "local chain"})`, () => {
  let anvilProc: ChildProcess;
  let env: Env;
  let deployment: Deployment;
  let chainId = 31337;
  let chain: ReturnType<typeof defineChain>;
  let test: ReturnType<typeof makeTest>;
  const makeTest = (c: ReturnType<typeof defineChain>) =>
    createTestClient({ chain: c, mode: "anvil", transport: http(RPC) }).extend(publicActions);
  const wallet = (pk: Hex) => createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(pk) });

  async function warpTo(t: number) {
    const now = Number((await test.getBlock()).timestamp);
    if (t > now) await test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(t)) });
    await test.mine({ blocks: 1 });
  }

  beforeAll(async () => {
    // On a fork that keeps chain id 4663, anvil emulates Arbitrum (block.number = L1 block, blockhash = 0), which the
    // real chain does not expose to the registry (it reads ArbSys). So the fork runs mainnet state under a local id.
    anvilProc = spawn(
      "anvil",
      ["--port", String(PORT), "--silent", ...(FORK ? ["--fork-url", FORK, "--chain-id", "31337"] : [])],
      {
        stdio: "ignore",
      },
    );
    const probe = createTestClient({ mode: "anvil", transport: http(RPC) }).extend(publicActions);
    for (let i = 0; i < 100; i++) {
      try {
        chainId = await probe.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    chain = defineChain({
      id: chainId,
      name: "test",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
    test = makeTest(chain);

    const contracts = resolve(import.meta.dirname, "../../../contracts");
    // deploy.sh records the deployment block from the receipts (in a script, block.number can be the L1 block)
    execFileSync("./deploy.sh", [RPC], {
      cwd: contracts,
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: DEPLOYER,
        ARBITER_ADDRESS: ARBITER,
        TREASURY_SEED_USDG: "250000",
        TREASURY_SEED_ETH_WEI: (20n * 10n ** 18n).toString(),
        ...(FORK ? { USDG_ADDRESS: MAINNET_USDG, BLOCK_SOURCE: "fork", MAINNET_FORK: "true" } : {}),
      },
      stdio: "ignore",
    });
    deployment = JSON.parse(readFileSync(resolve(contracts, `deployments/${chainId}.json`), "utf8"));
    if (FORK) expect(deployment.usdg.toLowerCase()).toBe(MAINNET_USDG.toLowerCase());

    env = {
      chainId,
      rpcUrls: [RPC],
      operatorKey: DEPLOYER,
      keeperKey: DEPLOYER,
      seedSecret: `0x${"ab".repeat(32)}`,
      deployment,
      pricingSamples: 24,
      margin: 0.06,
      minFreeLiquidity: 1_000n * 1_000_000n,
      minFreeLiquidityEth: 10n ** 17n,
      port: 0,
      tickMs: 0,
      instanceId: "e2e",
      alertWebhook: undefined,
    };
    // a fresh chain restarts bet and match ids, so start from empty tables (one database per deployment)
    await db().$executeRawUnsafe(
      `TRUNCATE "Claim", "BetSettlement", "Bet", "OddsSnapshot", "BettingMarket", "MatchEvent", "MatchStat", "MatchReplay", "MatchConfig", "Match", "SchedulerJob", "BlockchainTransaction", "ContractEvent", "TreasuryTransaction", "TreasurySnapshot", "CreatorFeeReceipt", "IndexerCursor", "Alert" CASCADE`,
    );

    for (const pk of BETTORS) await test.setBalance({ address: privateKeyToAccount(pk).address, value: 10n ** 18n });
    if (FORK) {
      // fund the treasury and the bettors with real USDG taken from an existing holder, on the fork only
      await test.impersonateAccount({ address: USDG_WHALE });
      await test.setBalance({ address: USDG_WHALE, value: 10n ** 18n });
      const whale = createWalletClient({ chain, transport: http(RPC), account: USDG_WHALE });
      const amount = 50_000n * 10n ** 6n;
      await test.waitForTransactionReceipt({
        hash: await whale.writeContract({
          address: deployment.usdg,
          abi: usdgAbi,
          functionName: "approve",
          args: [deployment.treasury, amount],
        }),
      });
      await test.waitForTransactionReceipt({
        hash: await whale.writeContract({
          address: deployment.treasury,
          abi: oddraTreasuryAbi,
          functionName: "contribute",
          args: [deployment.usdg, amount, HOUSE],
        }),
      });
      for (const pk of BETTORS)
        await test.waitForTransactionReceipt({
          hash: await whale.writeContract({
            address: deployment.usdg,
            abi: usdgAbi,
            functionName: "transfer",
            args: [privateKeyToAccount(pk).address, 1_000n * 10n ** 6n],
          }),
        });
    } else {
      for (const pk of BETTORS)
        await test.waitForTransactionReceipt({
          hash: await wallet(pk).writeContract({
            address: deployment.usdg,
            abi: oddraTestUSDGAbi,
            functionName: "faucet",
          }),
        });
    }
    for (const pk of BETTORS)
      await test.waitForTransactionReceipt({
        hash: await wallet(pk).writeContract({
          address: deployment.usdg,
          abi: usdgAbi,
          functionName: "approve",
          args: [deployment.book, 2n ** 255n],
        }),
      });
  }, 300_000);

  afterAll(() => {
    anvilProc?.kill();
  });

  it("commits, prices, takes USDG and ETH bets, locks, reveals, proposes, finalises after the dispute window, pays both assets and schedules the next match", async () => {
    const c = connect(env);
    let scheduler = new Scheduler(env, c);
    const indexer = new Indexer(env, c);
    const index = async () => {
      await test.mine({ blocks: 3 }); // the indexer reads blocks with 2 confirmations
      await indexer.run();
    };

    const t0 = Number((await test.getBlock()).timestamp);
    const cur = slotAt(t0).matchId;
    const id = cur + 1n;
    const s = slot(id);
    await warpTo(slot(cur).openTime + 400);

    // 1. commit + price + publish odds
    await scheduler.tick(true);
    let m = await scheduler.readMatch(id);
    expect(m.status).toBe(ST.Scheduled);
    expect(m.configHash).toBe(configHash(buildConfig(id, m.homeTeam, m.awayTeam)));
    await scheduler.tick(true);
    await scheduler.idle();
    await scheduler.tick(true);
    const [odds, version] = (await test.readContract({
      address: deployment.book,
      abi: oddraBookAbi,
      functionName: "odds",
      args: [id],
    })) as readonly [readonly number[], number];
    expect(version).toBe(1);

    // 2. betting: every 1X2 outcome is backed in USDG and in ETH, so each asset has a winner
    await warpTo(s.openTime + 5);
    const usdgStake = 25_000_000n; // 25 USDG
    const ethStake = 10n ** 16n; // 0.01 ETH
    for (let sel = 0; sel < 3; sel++) {
      const h = await wallet(BETTORS[sel]).writeContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "placeBet",
        args: [id, sel, usdgStake, odds[sel]],
      });
      expect((await test.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    }
    for (let sel = 0; sel < 3; sel++) {
      const h = await wallet(BETTORS[3]).writeContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "placeBetETH",
        args: [id, sel, odds[sel]],
        value: ethStake,
      });
      expect((await test.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    }
    await index();
    expect(await db().bet.count({ where: { matchId: id } })).toBe(6);
    expect(await db().bet.count({ where: { matchId: id, asset: "ETH" } })).toBe(3);

    // 3. kickoff: late bets are refused
    await warpTo(s.kickoff);
    await expect(
      wallet(BETTORS[0]).writeContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "placeBetETH",
        args: [id, 0, 0],
        value: ethStake,
      }),
    ).rejects.toThrow();
    await scheduler.tick(true); // lock
    expect((await scheduler.readMatch(id)).status).toBe(ST.Locked);

    // 4. the worker restarts between lock and reveal and carries on from chain state alone
    scheduler = new Scheduler(env, c);
    await test.mine({ blocks: 6 });
    await scheduler.tick(true); // reveal
    m = await scheduler.readMatch(id);
    expect(m.status).toBe(ST.Revealed);
    const replay = simulate(buildConfig(id, m.homeTeam, m.awayTeam), m.finalSeed);
    expect(resultHash(replay)).toBe(resultHash(scheduler.ensureSimulated(id, m)!));

    // 5. full time: the result is proposed, not final, and stays open during the dispute window
    await warpTo(s.fullTime + 1);
    await scheduler.tick(true);
    m = await scheduler.readMatch(id);
    expect(m.status).toBe(ST.Proposed);
    expect([m.homeGoals, m.awayGoals]).toEqual([replay.homeGoals, replay.awayGoals]);
    await scheduler.tick(true);
    expect((await scheduler.readMatch(id)).status).toBe(ST.Proposed);

    // 6. after the window: finalise, close both books, pay both assets automatically
    await warpTo(Number(m.proposedAt) + (await scheduler.disputeWindow()) + 1);
    await scheduler.tick(true); // finalize
    expect((await scheduler.readMatch(id)).status).toBe(ST.Settled);
    const winner = replay.homeGoals > replay.awayGoals ? 0 : replay.homeGoals === replay.awayGoals ? 1 : 2;
    const usdgWinner = privateKeyToAccount(BETTORS[winner]).address;
    const ethBettor = privateKeyToAccount(BETTORS[3]).address;
    const balanceOf = (a: Address) =>
      test.readContract({
        address: deployment.usdg,
        abi: usdgAbi,
        functionName: "balanceOf",
        args: [a],
      }) as Promise<bigint>;
    const u0 = await balanceOf(usdgWinner);
    const e0 = await test.getBalance({ address: ethBettor });
    await scheduler.tick(true); // settleBook
    await index();
    await scheduler.tick(true); // payoutBatch (the keeper pays the gas)
    await index();
    expect((await balanceOf(usdgWinner)) - u0).toBe((usdgStake * BigInt(odds[winner])) / 100n);
    expect((await test.getBalance({ address: ethBettor })) - e0).toBe((ethStake * BigInt(odds[winner])) / 100n);

    const states = (await db().bet.findMany({ where: { matchId: id } })).map((b) => `${b.asset}:${b.state}`).sort();
    expect(states).toEqual(["ETH:LOST", "ETH:LOST", "ETH:PAID", "USDG:LOST", "USDG:LOST", "USDG:PAID"]);

    // 7. both asset books fully released
    for (const asset of [deployment.usdg, ETH_ADDRESS])
      expect(
        await test.readContract({
          address: deployment.treasury,
          abi: oddraTreasuryAbi,
          functionName: "totalReserved",
          args: [asset],
        }),
      ).toBe(0n);

    // 8. the next match was committed automatically (by now the clock is past its kickoff, so it is already under way)
    const next = Number(
      await test.readContract({
        address: deployment.registry,
        abi: oddraMatchRegistryAbi,
        functionName: "status",
        args: [id + 1n],
      }),
    );
    expect(next).toBeGreaterThanOrEqual(ST.Scheduled);
    expect(next).not.toBe(ST.Voided);
  }, 600_000);
});
