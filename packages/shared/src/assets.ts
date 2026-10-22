import type { Address } from "viem";
import type { Deployment } from "./chain";

/** Native ETH, as the contracts identify it. */
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type AssetKey = "USDG" | "ETH";

export interface AssetInfo {
  key: AssetKey;
  address: Address;
  decimals: number;
  symbol: string;
}

export function assetsFor(d: Deployment): AssetInfo[] {
  return [
    { key: "USDG", address: d.usdg, decimals: 6, symbol: d.testToken ? "tUSDG" : "USDG" },
    { key: "ETH", address: ETH_ADDRESS, decimals: 18, symbol: "ETH" },
  ];
}

export const isEth = (asset: string) => asset.toLowerCase() === ETH_ADDRESS;

/** Base units to a display string, e.g. 1_500_000n with 6 decimals → "1.50". */
export function formatAmount(units: bigint | number | string, decimals: number, digits?: number): string {
  const n = Number(units) / 10 ** decimals;
  const d = digits ?? (decimals === 18 ? 4 : 2);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Parses a user-typed amount into base units, or null if invalid. */
export function parseAmount(s: string, decimals: number): bigint | null {
  if (!new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`).test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
