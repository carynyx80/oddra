import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

/** USDG base units (6 decimals) to a display string. */
export function fmtUsdg(units: bigint | number | string | null | undefined, digits = 2): string {
  if (units === null || units === undefined) return "–";
  const n = Number(units) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const parseUsdg = (s: string): bigint | null => {
  if (!/^\d*(\.\d{0,6})?$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};

export const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Formats a base-unit amount of a betting asset: "25.00 USDG" or "0.0100 ETH". */
export function fmtAsset(
  units: bigint | number | string | null | undefined,
  asset: "USDG" | "ETH",
  withSymbol = true,
): string {
  if (units === null || units === undefined) return "–";
  const decimals = asset === "ETH" ? 18 : 6;
  const n = Number(units) / 10 ** decimals;
  const digits = asset === "ETH" ? (n !== 0 && Math.abs(n) < 0.01 ? 5 : 4) : 2;
  const s = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return withSymbol ? `${s} ${asset}` : s;
}
