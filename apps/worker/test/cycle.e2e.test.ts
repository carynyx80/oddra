/**
 * Full match cycle against a real local chain (anvil) and a real Postgres, with the worker's own modules and real
 * transactions. Nothing is mocked: time moves only by advancing the chain's clock.
 *
 * Needs `anvil` and `forge` on PATH and DATABASE_URL pointing at a migrated database. Run with:
 *   E2E=1 DATABASE_URL=... npm test -w @oddra/worker
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient, createWalletClient, http, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db } from "@oddra/db";
import { buildConfig, configHash, resultHash, simulate } from "@oddra/engine";
import {
  anvil,
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
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's published development keys (local chain only)
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const BETTORS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as Hex[];

describe.skipIf(!RUN)("full match cycle on a local chain", () => {
  let anvilProc: ChildProcess;
  let env: Env;
  let deployment: Deployment;
  const test = createTestClient({ chain: anvil, mode: "anvil", transport: http(RPC) }).extend(publicActions);

  async function warpTo(t: number) {
    const now = Number((await test.getBlock()).timestamp);
    if (t > now) await test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(t)) });
    await test.mine({ blocks: 1 });
  }

  beforeAll(async () => {
    anvilProc = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await test.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const contracts = resolve(import.meta.dirname, "../../../contracts");
    execFileSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast"], {
      cwd: contracts,
      env: { ...process.env, DEPLOYER_PRIVATE_KEY: DEPLOYER, TREASURY_SEED_USDG: "250000" },
      stdio: "ignore",
    });
    deployment = JSON.parse(readFileSync(resolve(contracts, "deployments/31337.json"), "utf8"));
    env = {
      chainId: 31337,
      rpcUrls: [RPC],
      operatorKey: DEPLOYER,
      keeperKey: DEPLOYER,
      seedSecret: `0x${"ab".repeat(32)}`,
      deployment,
      pricingSamples: 24,
      margin: 0.06,
      minFreeLiquidity: 10_000n * 1_000_000n,
      port: 0,
      tickMs: 0,
      instanceId: "e2e",
      alertWebhook: undefined,
    };
    await db().indexerCursor.deleteMany({});
    // bettors: faucet + approve
    for (const pk of BETTORS) {
      const w = createWalletClient({ chain: anvil, transport: http(RPC), account: privateKeyToAccount(pk) });
      await test.waitForTransactionReceipt({
        hash: await w.writeContract({ address: deployment.usdg, abi: oddraTestUSDGAbi, functionName: "faucet" }),
      });
      await test.waitForTransactionReceipt({
        hash: await w.writeContract({
          address: deployment.usdg,
          abi: oddraTestUSDGAbi,
          functionName: "approve",
          args: [deployment.book, 2n ** 255n],
        }),
      });
    }
  }, 120_000);

  afterAll(() => {
    anvilProc?.kill();
  });

  it("commits, prices, takes bets, locks, reveals, settles, pays out and schedules the next match", async () => {
    const chain = connect(env);
    let scheduler = new Scheduler(env, chain);
    const indexer = new Indexer(env, chain);
    // the indexer only reads blocks with 2 confirmations
    const index = async () => {
      await test.mine({ blocks: 3 });
      await indexer.run();
    };

    // move to the middle of a slot so the *next* slot gets created
    const t0 = Number((await test.getBlock()).timestamp);
    const cur = slotAt(t0).matchId;
    const id = cur + 1n;
    const s = slot(id);
    await warpTo(slot(cur).openTime + 400);

    // 1. commit + price + publish odds
    await scheduler.tick(true);
    let m = await scheduler.readMatch(id);
    expect(m.status).toBe(1);
    const { home, away } = { home: m.homeTeam, away: m.awayTeam };
    expect(m.configHash).toBe(configHash(buildConfig(id, home, away)));
    await scheduler.tick(true); // starts pricing
    await scheduler.idle();
    await scheduler.tick(true); // publishes odds
    const [odds, version] = (await test.readContract({
      address: deployment.book,
      abi: oddraBookAbi,
      functionName: "odds",
      args: [id],
    })) as readonly [readonly number[], number];
    expect(version).toBe(1);
    expect(odds[0]).toBeGreaterThan(100);

    // 2. betting window opens: three bettors back home, draw and away (one of them must win)
    await warpTo(s.openTime + 5);
    const sels = [0, 1, 2];
    for (let i = 0; i < 3; i++) {
      const w = createWalletClient({ chain: anvil, transport: http(RPC), account: privateKeyToAccount(BETTORS[i]) });
      const hash = await w.writeContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "placeBet",
        args: [id, sels[i], 25_000_000n, odds[sels[i]]],
      });
      expect((await test.waitForTransactionReceipt({ hash })).status).toBe("success");
    }
    await index();
    expect(await db().bet.count({ where: { matchId: id } })).toBe(3);

    // 3. kickoff: late bets are refused by the contract
    await warpTo(s.kickoff);
    const late = createWalletClient({ chain: anvil, transport: http(RPC), account: privateKeyToAccount(BETTORS[0]) });
    await expect(
      late.writeContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "placeBet",
        args: [id, 0, 5_000_000n, 0],
      }),
    ).rejects.toThrow();

    await scheduler.tick(true); // lock
    expect((await scheduler.readMatch(id)).status).toBe(2);

    // 4. the worker restarts between lock and reveal: a fresh instance carries on from chain state alone
    scheduler = new Scheduler(env, chain);
    await test.mine({ blocks: 6 });
    await scheduler.tick(true); // reveal
    m = await scheduler.readMatch(id);
    expect(m.status).toBe(3);

    // independent replay from public data only
    const replay = simulate(buildConfig(id, m.homeTeam, m.awayTeam), m.finalSeed);
    expect(resultHash(replay)).toBe(resultHash(scheduler.ensureSimulated(id, m)!));

    // 5. full time: settle, close the book, pay winners automatically
    await warpTo(s.fullTime + 1);
    await scheduler.tick(true); // settle (and create the next match)
    m = await scheduler.readMatch(id);
    expect(m.status).toBe(4);
    expect([m.homeGoals, m.awayGoals]).toEqual([replay.homeGoals, replay.awayGoals]);
    expect(m.resultHash).toBe(resultHash(replay));

    const winner = replay.homeGoals > replay.awayGoals ? 0 : replay.homeGoals === replay.awayGoals ? 1 : 2;
    const winnerAddr = privateKeyToAccount(BETTORS[winner]).address as Address;
    const before = (await test.readContract({
      address: deployment.usdg,
      abi: oddraTestUSDGAbi,
      functionName: "balanceOf",
      args: [winnerAddr],
    })) as bigint;
    await scheduler.tick(true); // settleBook
    await index();
    await scheduler.tick(true); // payoutBatch
    await index();
    const after = (await test.readContract({
      address: deployment.usdg,
      abi: oddraTestUSDGAbi,
      functionName: "balanceOf",
      args: [winnerAddr],
    })) as bigint;
    expect(after - before).toBe((25_000_000n * BigInt(odds[winner])) / 100n);

    const paid = await db().bet.findMany({ where: { matchId: id }, orderBy: { id: "asc" } });
    expect(paid.map((b) => b.state).sort()).toEqual(["LOST", "LOST", "PAID"]);

    // 6. treasury accounting: nothing left reserved for this match, payouts recorded
    const [reserved, payouts] = await Promise.all([
      test.readContract({ address: deployment.treasury, abi: oddraTreasuryAbi, functionName: "totalReserved" }),
      test.readContract({ address: deployment.treasury, abi: oddraTreasuryAbi, functionName: "totalPayouts" }),
    ]);
    expect(reserved).toBe(0n);
    expect(payouts).toBe(after - before);

    // 7. the next match was committed automatically, before its window opened
    const next = (await test.readContract({
      address: deployment.registry,
      abi: oddraMatchRegistryAbi,
      functionName: "status",
      args: [id + 1n],
    })) as number;
    expect(next).toBe(1);
  }, 600_000);
});
