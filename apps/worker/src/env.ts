import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import type { Deployment } from "@oddra/shared";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see .env.example)`);
  return v;
}

function hex32(name: string): Hex {
  const v = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be 32 bytes of 0x-prefixed hex`);
  return v as Hex;
}

/** Contract addresses: contracts/deployments/<chainId>.json, overridable one by one through env. */
function loadDeployment(chainId: number): Deployment {
  const file =
    process.env.DEPLOYMENT_FILE ?? resolve(import.meta.dirname, `../../../contracts/deployments/${chainId}.json`);
  const base: Partial<Deployment> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const pick = (k: keyof Deployment, env: string) => (process.env[env] as Address | undefined) ?? (base[k] as Address);
  const d = {
    chainId,
    deployedAtBlock: Number(process.env.DEPLOYED_AT_BLOCK ?? base.deployedAtBlock ?? 0),
    mode: (process.env.MODE as Deployment["mode"]) ?? base.mode ?? (base.exchange ? "exchange" : "house"),
    exchange: pick("exchange", "EXCHANGE_ADDRESS"),
    testToken: base.testToken ?? true,
    usdg: pick("usdg", "USDG_ADDRESS"),
    registry: pick("registry", "REGISTRY_ADDRESS"),
    treasury: pick("treasury", "TREASURY_ADDRESS"),
    risk: pick("risk", "RISK_ADDRESS"),
    book: pick("book", "BOOK_ADDRESS"),
    feeCollector: pick("feeCollector", "FEE_COLLECTOR_ADDRESS"),
  } as Deployment;
  const needed =
    d.mode === "exchange"
      ? (["usdg", "registry", "exchange"] as const)
      : (["usdg", "registry", "treasury", "book"] as const);
  for (const k of needed) if (!d[k]) throw new Error(`missing ${k} address: deploy the contracts or set it in env`);
  return d;
}

export function loadEnv() {
  const chainId = Number(process.env.CHAIN_ID ?? 46630);
  return {
    chainId,
    rpcUrls: (process.env.RPC_URLS ?? process.env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    operatorKey: hex32("OPERATOR_PRIVATE_KEY"),
    keeperKey: (process.env.KEEPER_PRIVATE_KEY as Hex | undefined) ?? hex32("OPERATOR_PRIVATE_KEY"),
    seedSecret: hex32("SERVER_SEED_SECRET"),
    deployment: loadDeployment(chainId),
    pricingSamples: Number(process.env.PRICING_SAMPLES ?? 200),
    margin: Number(process.env.ODDS_MARGIN ?? 0.06),
    /** Do not open a new match unless the treasury has at least this much free USDG (whole units). */
    minFreeLiquidity: BigInt(process.env.MIN_FREE_LIQUIDITY_USDG ?? 10_000) * 1_000_000n,
    /** The same gate for the ETH book, in wei. */
    minFreeLiquidityEth: BigInt(process.env.MIN_FREE_LIQUIDITY_ETH_WEI ?? 10n ** 17n),
    port: Number(process.env.PORT ?? 8787),
    tickMs: Number(process.env.TICK_MS ?? 2_000),
    instanceId: process.env.WORKER_ID ?? `worker-${process.pid}`,
    alertWebhook: process.env.ALERT_WEBHOOK_URL,
  };
}

export type Env = ReturnType<typeof loadEnv>;
