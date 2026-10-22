import type { Address } from "viem";
import { chainById, type Deployment } from "@oddra/shared";
import mainnetDeployment from "../../../contracts/deployments/4663.json";
import testnet from "../../../contracts/deployments/46630.json";

/**
 * Public, non-secret configuration. Contract addresses come from the committed testnet deployment file, and any
 * NEXT_PUBLIC_* variable overrides it (for example a fresh deployment or a local anvil).
 */
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 46630);
const base = (chainId === 46630 ? testnet : chainId === 4663 ? mainnetDeployment : {}) as Partial<Deployment>;
const addr = (env: string | undefined, fallback?: string) => (env || fallback || "") as Address;

export const deployment: Deployment = {
  chainId,
  deployedAtBlock: Number(base.deployedAtBlock ?? 0),
  testToken: base.testToken ?? true,
  usdg: addr(process.env.NEXT_PUBLIC_USDG_ADDRESS, base.usdg),
  registry: addr(process.env.NEXT_PUBLIC_REGISTRY_ADDRESS, base.registry),
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY_ADDRESS, base.treasury),
  risk: addr(process.env.NEXT_PUBLIC_RISK_ADDRESS, base.risk),
  book: addr(process.env.NEXT_PUBLIC_BOOK_ADDRESS, base.book),
  feeCollector: addr(process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS, base.feeCollector),
};

export const chain = chainById(chainId);
/** Real funds: Robinhood Chain mainnet with Paxos USDG and native ETH. */
export const isMainnet = chainId === 4663;
export const usdgSymbol = deployment.testToken ? "tUSDG" : "USDG";
export const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0];
export const liveUrl = process.env.NEXT_PUBLIC_LIVE_URL || "";
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";
export const deployed = Boolean(deployment.book && deployment.registry);

/** $ODRA has not launched. Set NEXT_PUBLIC_ODRA_TOKEN_ADDRESS only to the verified address once it exists. */
export const odraToken = (process.env.NEXT_PUBLIC_ODRA_TOKEN_ADDRESS || "") as Address | "";

/** Paxos USDG on Robinhood Chain (Paxos docs; see docs/VERIFIED_ADDRESSES.md). */
export const REAL_USDG = {
  testnet: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  mainnet: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
} as const;

export const explorer = chain.blockExplorers?.default.url ?? "";
export const txUrl = (h: string) => (explorer ? `${explorer}/tx/${h}` : "#");
export const addressUrl = (a: string) => (explorer ? `${explorer}/address/${a}` : "#");
