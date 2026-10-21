/**
 * Oddra worker: the always-on process behind the platform. It commits matches, prices them, locks and reveals them,
 * replays the engine, settles results, pays winners, indexes the chain and broadcasts the live feed.
 *
 * It holds no state that matters: everything is re-derived from the chain on every tick, so a restart, a crash or a
 * second instance taking over never double-acts or loses a match. Run it on a persistent host (Railway, Fly.io,
 * Render, a VM) — never on Vercel serverless functions.
 */
import { db, hasDatabase } from "@oddra/db";
import { connect } from "./chain";
import { loadEnv } from "./env";
import { Indexer } from "./indexer";
import { acquireLease, ensureLeaseTable, releaseLease } from "./lease";
import { LiveHub } from "./live";
import { errMsg, log } from "./log";
import { Scheduler } from "./scheduler";

const env = loadEnv();
const chain = connect(env);
const scheduler = new Scheduler(env, chain);
const indexer = hasDatabase() ? new Indexer(env, chain) : null;

let leader = false;
let lastTickOk = 0;
let lastIndexed = 0n;
let stopping = false;
const startedAt = new Date();

const hub = new LiveHub(scheduler, env.port, () => ({
  ok: lastTickOk > 0 && scheduler.status.chainTime - lastTickOk < 30,
  instance: env.instanceId,
  leader,
  chainId: env.chainId,
  chainTime: scheduler.status.chainTime,
  lastTickOk,
  lastIndexedBlock: lastIndexed.toString(),
  operator: chain.operator.account.address,
  keeper: chain.keeper.account.address,
  safeState: scheduler.status.safeState,
  currentMatchId: scheduler.status.currentMatchId,
  matches: scheduler.status.matches,
  pricing: scheduler.status.pricing,
  errors: scheduler.status.errors.slice(0, 10),
}));

async function heartbeat() {
  if (!hasDatabase()) return;
  await db().workerHeartbeat.upsert({
    where: { id: env.instanceId },
    create: {
      id: env.instanceId,
      role: leader ? "leader" : "standby",
      startedAt,
      beatAt: new Date(),
      chainTime: new Date(scheduler.status.chainTime * 1000),
      info: {},
    },
    update: {
      role: leader ? "leader" : "standby",
      beatAt: new Date(),
      chainTime: scheduler.status.chainTime ? new Date(scheduler.status.chainTime * 1000) : null,
      info: JSON.parse(
        JSON.stringify({
          safeState: scheduler.status.safeState,
          matches: scheduler.status.matches,
          errors: scheduler.status.errors.slice(0, 5),
          lastIndexed: lastIndexed.toString(),
        }),
      ),
    },
  });
}

async function loop() {
  let beat = 0;
  while (!stopping) {
    const started = performance.now();
    try {
      leader = hasDatabase() ? await acquireLease(env.instanceId) : true;
      await scheduler.tick(leader);
      lastTickOk = scheduler.status.chainTime;
      if (leader && indexer) {
        lastIndexed = await indexer.run();
        await indexer.snapshot().catch((e) => log.warn("snapshot failed", { error: errMsg(e) }));
      }
      if (beat++ % 5 === 0) await heartbeat().catch((e) => log.warn("heartbeat failed", { error: errMsg(e) }));
    } catch (e) {
      log.error("tick failed", { error: errMsg(e) });
    }
    const wait = Math.max(200, env.tickMs - (performance.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function main() {
  log.info("oddra worker starting", {
    chainId: env.chainId,
    instance: env.instanceId,
    operator: chain.operator.account.address,
    registry: env.deployment.registry,
    book: env.deployment.book,
    database: hasDatabase(),
  });
  if (hasDatabase()) await ensureLeaseTable();
  await chain.refreshTime();
  const pulse = setInterval(() => hub.pulse(), 1_000);
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { sig });
    clearInterval(pulse);
    hub.close();
    if (hasDatabase()) await releaseLease(env.instanceId).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await loop();
}

main().catch((e) => {
  log.error("fatal", { error: errMsg(e) });
  process.exit(1);
});
