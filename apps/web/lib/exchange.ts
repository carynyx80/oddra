"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import {
  ETH_ADDRESS,
  ST,
  isEth,
  oddraExchangeAbi,
  oddraMatchRegistryAbi,
  selectionWins,
  winMask,
  type AssetKey,
} from "@oddra/shared";
import { deployed, deployment, exchangeMode } from "./config";

export type Side = "back" | "lay";
const SIDE = ["back", "lay"] as const;

export interface OfferRow {
  id: bigint;
  maker: Address;
  matchId: bigint;
  selection: number;
  side: Side;
  odds: number;
  closed: boolean;
  asset: AssetKey;
  amount: bigint;
  /** backer-stake still available */
  remaining: bigint;
  escrow: bigint;
}

interface RawOffer {
  maker: Address;
  matchId: bigint;
  selection: number;
  side: number;
  odds: number;
  closed: boolean;
  asset: Address;
  amount: bigint;
  remaining: bigint;
  escrow: bigint;
}

const toOffer = (id: bigint, o: RawOffer): OfferRow => ({
  id,
  maker: o.maker,
  matchId: o.matchId,
  selection: Number(o.selection),
  side: SIDE[Number(o.side)],
  odds: Number(o.odds),
  closed: o.closed,
  asset: isEth(o.asset) ? "ETH" : "USDG",
  amount: o.amount,
  remaining: o.remaining,
  escrow: o.escrow,
});

export const assetAddress = (a: AssetKey): Address => (a === "ETH" ? ETH_ADDRESS : deployment.usdg);

/** Liability for laying `stake` at `odds` (× 100), rounded up exactly as the contract does. */
export const liabilityFor = (stake: bigint, odds: number) => (stake * BigInt(odds - 100) + 99n) / 100n;

/** Every open offer of a match, straight from the contract. */
export function useOrderBook(matchId: bigint | null | undefined, refetchMs = 4_000) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["orderbook", matchId?.toString()],
    enabled: deployed && exchangeMode && matchId != null && !!client,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<OfferRow[]> => {
      const [ids, list] = (await client!.readContract({
        address: deployment.exchange!,
        abi: oddraExchangeAbi,
        functionName: "matchOffers",
        args: [matchId!],
      })) as readonly [readonly bigint[], readonly RawOffer[]];
      return ids.map((id, i) => toOffer(id, list[i])).filter((o) => !o.closed && o.remaining > 0n);
    },
  });
}

export interface BestPrices {
  /** best odds a backer can take now (from lay offers), with the stake available at that price */
  back: { odds: number; available: bigint } | null;
  /** best odds a layer can take now (from back offers) */
  lay: { odds: number; available: bigint } | null;
}

/** Best back and lay price per selection for one asset. */
export function bestPrices(offers: OfferRow[], asset: AssetKey, selections: number): BestPrices[] {
  const out: BestPrices[] = Array.from({ length: selections }, () => ({ back: null, lay: null }));
  for (const o of offers) {
    if (o.asset !== asset) continue;
    const b = out[o.selection];
    if (!b) continue;
    if (o.side === "lay") {
      if (!b.back || o.odds > b.back.odds) b.back = { odds: o.odds, available: o.remaining };
      else if (o.odds === b.back.odds) b.back.available += o.remaining;
    } else {
      if (!b.lay || o.odds < b.lay.odds) b.lay = { odds: o.odds, available: o.remaining };
      else if (o.odds === b.lay.odds) b.lay.available += o.remaining;
    }
  }
  return out;
}

export interface Fill {
  offer: OfferRow;
  /** backer-stake units */
  amount: bigint;
  /** what the taker pays for this fill */
  cost: bigint;
}

export interface Plan {
  fills: Fill[];
  matched: bigint;
  /** stake left over to post as a new offer at the requested odds (0 if none, or too small) */
  remainder: bigint;
  remainderEscrow: bigint;
  /** remainder below the minimum offer size: it cannot be posted */
  dust: bigint;
  /** taker cost of the fills plus the remainder's escrow */
  total: bigint;
  takeValue: bigint;
  /** profit if this side wins, before commission */
  winGross: bigint;
}

/**
 * How a back or lay order of `stake` (backer-stake units) at `odds` or better is executed: fill the best opposing
 * offers first, then (optionally) post what is left as an offer. Mirrors the contract's rules so the transaction
 * does not revert: no self-matching, and no partial fill below the minimum amount.
 */
export function planOrder(args: {
  offers: OfferRow[];
  me?: Address;
  selection: number;
  side: Side;
  asset: AssetKey;
  odds: number;
  stake: bigint;
  minAmount: bigint;
  postRemainder: boolean;
}): Plan {
  const { offers, me, selection, side, asset, odds, stake, minAmount, postRemainder } = args;
  const against = offers
    .filter(
      (o) =>
        o.selection === selection &&
        o.asset === asset &&
        o.side !== side &&
        o.maker.toLowerCase() !== me?.toLowerCase() &&
        (side === "back" ? o.odds >= odds : o.odds <= odds),
    )
    .sort((a, b) => (side === "back" ? b.odds - a.odds : a.odds - b.odds) || Number(a.id - b.id));
  const fills: Fill[] = [];
  let left = stake;
  for (const o of against) {
    if (left === 0n) break;
    const amount = left < o.remaining ? left : o.remaining;
    // the contract rejects a partial fill below the minimum (it would only be dust)
    if (amount < minAmount && amount !== o.remaining) continue;
    const cost = side === "back" ? amount : liabilityFor(amount, o.odds);
    fills.push({ offer: o, amount, cost });
    left -= amount;
  }
  const matched = stake - left;
  const canPost = postRemainder && left >= minAmount && left > 0n;
  const remainder = canPost ? left : 0n;
  const remainderEscrow = remainder === 0n ? 0n : side === "back" ? remainder : liabilityFor(remainder, odds);
  const takeCost = fills.reduce((s, f) => s + f.cost, 0n);
  // backing wins the layer's liability; laying wins the backer's stake
  const winGross =
    fills.reduce((s, f) => s + (side === "back" ? (f.amount * BigInt(f.offer.odds - 100)) / 100n : f.amount), 0n) +
    (remainder === 0n ? 0n : side === "back" ? (remainder * BigInt(odds - 100)) / 100n : remainder);
  return {
    fills,
    matched,
    remainder,
    remainderEscrow,
    dust: postRemainder && !canPost ? left : 0n,
    total: takeCost + remainderEscrow,
    takeValue: asset === "ETH" ? takeCost : 0n,
    winGross,
  };
}

export interface ExchangeSettings {
  commissionBps: number;
  minAmount: Record<AssetKey, bigint>;
}

export function useExchangeSettings() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["exchange-settings"],
    enabled: deployed && exchangeMode && !!client,
    staleTime: 60_000,
    queryFn: async (): Promise<ExchangeSettings> => {
      const x = { address: deployment.exchange!, abi: oddraExchangeAbi } as const;
      const [bps, mu, me] = await Promise.all([
        client!.readContract({ ...x, functionName: "commissionBps" }),
        client!.readContract({ ...x, functionName: "minAmount", args: [deployment.usdg] }),
        client!.readContract({ ...x, functionName: "minAmount", args: [ETH_ADDRESS] }),
      ]);
      return { commissionBps: Number(bps), minAmount: { USDG: mu as bigint, ETH: me as bigint } };
    },
  });
}

export interface PositionRow {
  id: bigint;
  matchId: bigint;
  selection: number;
  odds: number;
  asset: AssetKey;
  /** the wallet's side of this position */
  side: Side;
  stake: bigint;
  liability: bigint;
  /** what the wallet put in */
  risked: bigint;
  /** the wallet's side was paid out */
  paid: boolean;
  claimable: bigint;
  fee: bigint;
  status: "Open" | "Won" | "Lost" | "Void";
}

/** The wallet's offers and matched positions, from the contract (no database needed). */
export function useMyExchange(owner?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["xbets", owner],
    enabled: deployed && exchangeMode && !!owner && !!client,
    refetchInterval: 8_000,
    queryFn: async () => {
      const x = { address: deployment.exchange!, abi: oddraExchangeAbi } as const;
      const [offerIds, positionIds] = (await Promise.all([
        client!.readContract({ ...x, functionName: "offersOf", args: [owner!] }),
        client!.readContract({ ...x, functionName: "positionsOf", args: [owner!] }),
      ])) as [readonly bigint[], readonly bigint[]];
      const oIds = [...offerIds].reverse().slice(0, 100);
      const pIds = [...positionIds].reverse().slice(0, 200);
      const [offers, positions, claims] = await Promise.all([
        Promise.all(oIds.map((id) => client!.readContract({ ...x, functionName: "getOffer", args: [id] }))),
        Promise.all(pIds.map((id) => client!.readContract({ ...x, functionName: "getPosition", args: [id] }))),
        Promise.all(pIds.map((id) => client!.readContract({ ...x, functionName: "claimable", args: [id, owner!] }))),
      ]);
      const ps = positions as unknown as {
        backer: Address;
        layer: Address;
        matchId: bigint;
        selection: number;
        odds: number;
        backerPaid: boolean;
        layerPaid: boolean;
        asset: Address;
        stake: bigint;
        liability: bigint;
      }[];
      const matchIds = [...new Set(ps.map((p) => p.matchId))];
      const statuses = await Promise.all(
        matchIds.map((m) =>
          client!.readContract({
            address: deployment.registry,
            abi: oddraMatchRegistryAbi,
            functionName: "getMatch",
            args: [m],
          }),
        ),
      );
      const matchOf = new Map(
        matchIds.map((m, i) => [
          m,
          statuses[i] as unknown as { status: number; homeGoals: number; awayGoals: number; firstScorer: number },
        ]),
      );
      const rows: PositionRow[] = ps.map((p, i) => {
        const backer = p.backer.toLowerCase() === owner!.toLowerCase();
        const [amount, fee] = claims[i] as readonly [bigint, bigint, number];
        const m = matchOf.get(p.matchId)!;
        const st = Number(m.status);
        let status: PositionRow["status"] = "Open";
        if (st === ST.Voided) status = "Void";
        else if (st === ST.Settled) {
          const backWins = selectionWins(winMask(m.homeGoals, m.awayGoals, m.firstScorer), Number(p.selection));
          status = backWins === backer ? "Won" : "Lost";
        }
        return {
          id: pIds[i],
          matchId: p.matchId,
          selection: Number(p.selection),
          odds: Number(p.odds),
          asset: isEth(p.asset) ? "ETH" : "USDG",
          side: backer ? "back" : "lay",
          stake: p.stake,
          liability: p.liability,
          risked: backer ? p.stake : p.liability,
          paid: backer ? p.backerPaid : p.layerPaid,
          claimable: amount,
          fee,
          status,
        };
      });
      return {
        offers: oIds.map((id, i) => toOffer(id, offers[i] as unknown as RawOffer)),
        positions: rows,
      };
    },
  });
}

/** Exchange-wide totals per asset (replaces the treasury view in exchange mode). */
export function useExchangeTotals() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["exchange-totals"],
    enabled: deployed && exchangeMode && !!client,
    refetchInterval: 10_000,
    queryFn: async () => {
      const x = { address: deployment.exchange!, abi: oddraExchangeAbi } as const;
      const read = async (asset: Address) => {
        const [matched, escrowed, fees] = (await Promise.all([
          client!.readContract({ ...x, functionName: "totalMatched", args: [asset] }),
          client!.readContract({ ...x, functionName: "totalEscrowed", args: [asset] }),
          client!.readContract({ ...x, functionName: "accruedFees", args: [asset] }),
        ])) as [bigint, bigint, bigint];
        return { matched, escrowed, fees };
      };
      const [USDG, ETH, offers, positions, bps, paused] = await Promise.all([
        read(deployment.usdg),
        read(ETH_ADDRESS),
        client!.readContract({ ...x, functionName: "offerCount" }) as Promise<bigint>,
        client!.readContract({ ...x, functionName: "positionCount" }) as Promise<bigint>,
        client!.readContract({ ...x, functionName: "commissionBps" }),
        client!.readContract({ ...x, functionName: "paused" }) as Promise<boolean>,
      ]);
      return { USDG, ETH, offers, positions, commissionBps: Number(bps), paused };
    },
  });
}
