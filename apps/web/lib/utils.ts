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
