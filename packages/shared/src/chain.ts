import { defineChain, type Address, type Chain } from "viem";
import { robinhoodTestnet } from "viem/chains";

/** Robinhood Chain testnet (46630), as published in viem: RPC, Blockscout explorer and Multicall3. */
export { robinhoodTestnet };

export const anvil = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const CHAINS: Record<number, Chain> = { [robinhoodTestnet.id]: robinhoodTestnet, [anvil.id]: anvil };

/** Robinhood Chain mainnet (4663) is deliberately absent: real-money wagering stays disabled. */
export function chainById(id: number): Chain {
  const c = CHAINS[id];
  if (!c) throw new Error(`Oddra does not support chain ${id}. Only testnet (46630) and anvil (31337) are allowed.`);
  return c;
}

export interface Deployment {
  chainId: number;
  deployedAtBlock: number;
  testToken: boolean;
  usdg: Address;
  registry: Address;
  treasury: Address;
  risk: Address;
  book: Address;
  feeCollector: Address;
}

export function explorerUrl(chain: Chain, kind: "tx" | "address" | "block", value: string): string | null {
  const base = chain.blockExplorers?.default.url;
  return base ? `${base}/${kind}/${value}` : null;
}

export const USDG_DECIMALS = 6;
export const usdg = (units: bigint | number) => Number(units) / 1e6;
export const toUnits = (amount: number) => BigInt(Math.round(amount * 1e6));
