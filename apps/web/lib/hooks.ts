"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { zeroHash, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import type { MatchEvent, MatchResult } from "@oddra/engine";
import {
  oddraBookAbi,
  oddraMatchRegistryAbi,
  oddraTestUSDGAbi,
  oddraTreasuryAbi,
  phaseOf,
  slot,
  slotAt,
} from "@oddra/shared";
import { deployed, deployment, liveUrl } from "./config";

export const STATUS = ["None", "Scheduled", "Locked", "Revealed", "Settled", "Voided"] as const;
export type StatusName = (typeof STATUS)[number];

// ------------------------------------------------------------------ time

let offset: number | null = null; // chain time minus local time, seconds
const listeners = new Set<() => void>();

/** Chain time right now, for animation loops (null until the first sync). */
export const chainNowSync = () => (offset === null ? null : Date.now() / 1000 + offset);

/**
 * Chain time, not the browser clock: betting deadlines are enforced by block timestamps, and a device clock can be
 * hours off. The offset is re-measured every 30 s from the latest block.
 */
export function useChainNow(intervalMs = 250): number | null {
  const client = usePublicClient();
  const [now, setNow] = useState<number | null>(offset === null ? null : Date.now() / 1000 + offset);
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      try {
        const t0 = Date.now();
        const b = await client!.getBlock({ blockTag: "latest" });
        const t1 = Date.now();
        offset = Number(b.timestamp) + 0.5 - (t0 + t1) / 2000; // block timestamps are whole seconds
        listeners.forEach((l) => l());
      } catch {
        /* keep the previous offset */
      }
    };
    if (offset === null) void sync();
    const s = setInterval(sync, 30_000);
    const t = setInterval(() => alive && offset !== null && setNow(Date.now() / 1000 + offset), intervalMs);
    const l = () => setNow(Date.now() / 1000 + (offset ?? 0));
    listeners.add(l);
    return () => {
      alive = false;
      clearInterval(s);
      clearInterval(t);
      listeners.delete(l);
    };
  }, [client, intervalMs]);
  return now;
}

// ------------------------------------------------------------------ matches

export interface OnchainMatch {
  openTime: bigint;
  kickoff: bigint;
  homeTeam: number;
  awayTeam: number;
  status: number;
  homeGoals: number;
  awayGoals: number;
  firstScorer: number;
  entropyBlock: bigint;
  configHash: Hex;
  rulesetHash: Hex;
  seedCommit: Hex;
  entropy: Hex;
  serverSeed: Hex;
  finalSeed: Hex;
  resultHash: Hex;
}

export interface MatchView {
  id: bigint;
  m: OnchainMatch;
  status: StatusName;
  odds: number[];
  oddsVersion: number;
  book: { settled: boolean; voided: boolean; winMask: number; totalStakes: bigint; reserved: bigint; owed: bigint };
}

export function useMatch(id: bigint | null | undefined, refetchMs = 4_000) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["match", id?.toString()],
    enabled: deployed && id != null && !!client,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<MatchView> => {
      const [m, [odds, oddsVersion], bs] = await Promise.all([
        client!.readContract({
          address: deployment.registry,
          abi: oddraMatchRegistryAbi,
          functionName: "getMatch",
          args: [id!],
        }),
        client!.readContract({ address: deployment.book, abi: oddraBookAbi, functionName: "odds", args: [id!] }),
        client!.readContract({ address: deployment.book, abi: oddraBookAbi, functionName: "bookState", args: [id!] }),
      ]);
      const mm = m as unknown as OnchainMatch;
      return {
        id: id!,
        m: mm,
        status: STATUS[mm.status],
        odds: [...(odds as readonly number[])],
        oddsVersion: Number(oddsVersion),
        book: {
          settled: bs[0],
          voided: bs[1],
          winMask: Number(bs[2]),
          totalStakes: bs[3],
          reserved: bs[4],
          owed: bs[5],
        },
      };
    },
  });
}

/** The current slot, the previous one and the next one, from chain time. */
export function useSchedule() {
  const now = useChainNow(250);
  const curId = now === null ? null : slotAt(now).matchId;
  const current = useMatch(curId);
  const next = useMatch(curId === null ? null : curId + 1n, 8_000);
  const prev = useMatch(curId === null ? null : curId - 1n, 8_000);
  const s = curId === null ? null : slot(curId);
  return { now, curId, slot: s, phase: s && now !== null ? phaseOf(s, now) : null, current, next, prev };
}

// ------------------------------------------------------------------ simulation (Web Worker)

const simCache = new Map<string, MatchResult>();

/** Replays a revealed match locally from public data: team ids + the on-chain final seed. */
export function useSimulation(id: bigint | null | undefined, home?: number, away?: number, seed?: Hex) {
  const key = id != null && seed && seed !== zeroHash ? `${id}-${home}-${away}-${seed}` : null;
  const [result, setResult] = useState<MatchResult | null>(key ? (simCache.get(key) ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key || home === undefined || away === undefined) {
      setResult(null);
      return;
    }
    const cached = simCache.get(key);
    if (cached) {
      setResult(cached);
      return;
    }
    setResult(null);
    const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ ok: true; result: MatchResult } | { ok: false; error: string }>) => {
      if (e.data.ok) {
        simCache.set(key, e.data.result);
        if (simCache.size > 6) simCache.delete(simCache.keys().next().value!);
        setResult(e.data.result);
      } else setError(e.data.error);
      w.terminate();
    };
    w.postMessage({ id: id!.toString(), home, away, seed });
    return () => w.terminate();
  }, [key, id, home, away, seed]);
  return { result, error };
}

// ------------------------------------------------------------------ live feed (optional WebSocket)

export interface LiveState {
  connected: boolean;
  safeState: string | null;
  events: Map<string, MatchEvent & { text: string | null }>;
}

/**
 * Subscribes to the worker's live feed when NEXT_PUBLIC_LIVE_URL is set. Reconnects with backoff, ignores duplicate
 * and out-of-order messages by (matchId, seq). The pitch never depends on it: positions are replayed locally.
 */
export function useLiveFeed(matchId: bigint | null): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, safeState: null, events: new Map() });
  const ref = useRef(state);
  ref.current = state;
  useEffect(() => {
    if (!liveUrl) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const open = () => {
      ws = new WebSocket(liveUrl);
      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) timer = setTimeout(open, Math.min(15_000, 500 * 2 ** retry++));
      };
      ws.onmessage = (msg) => {
        const d = JSON.parse(msg.data as string);
        if (d.type === "state") setState((s) => (s.safeState === d.safeState ? s : { ...s, safeState: d.safeState }));
        if (d.type === "event" && (!matchId || d.matchId === matchId.toString())) {
          const k = `${d.matchId}:${d.event.seq}`;
          if (ref.current.events.has(k)) return;
          setState((s) => {
            const events = new Map(s.events);
            events.set(k, { ...d.event, text: d.text });
            return { ...s, events };
          });
        }
      };
    };
    open();
    const onVisible = () => {
      if (document.visibilityState === "visible" && ws?.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        retry = 0;
        open();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ws?.close();
    };
  }, [matchId]);
  return state;
}

// ------------------------------------------------------------------ wallet

export function useUsdg(owner?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["usdg", owner],
    enabled: deployed && !!owner && !!client,
    refetchInterval: 6_000,
    queryFn: async () => {
      const [balance, allowance, lastDrip] = await Promise.all([
        client!.readContract({
          address: deployment.usdg,
          abi: oddraTestUSDGAbi,
          functionName: "balanceOf",
          args: [owner!],
        }) as Promise<bigint>,
        client!.readContract({
          address: deployment.usdg,
          abi: oddraTestUSDGAbi,
          functionName: "allowance",
          args: [owner!, deployment.book],
        }) as Promise<bigint>,
        deployment.testToken
          ? (client!.readContract({
              address: deployment.usdg,
              abi: oddraTestUSDGAbi,
              functionName: "lastDrip",
              args: [owner!],
            }) as Promise<bigint>)
          : Promise.resolve(0n),
      ]);
      return { balance, allowance, lastDrip };
    },
  });
}

export interface BetRow {
  id: bigint;
  matchId: bigint;
  selection: number;
  odds: number;
  stake: bigint;
  payout: bigint;
  placedAt: bigint;
  paid: boolean;
  status: "Open" | "Won" | "Lost" | "Refund" | "Paid";
  claimable: bigint;
  /** true if the selection won, false if it lost or was refunded, null while the match is open */
  won: boolean | null;
}

const BET_STATUS = ["Open", "Won", "Lost", "Refund", "Paid"] as const;

/** All of a wallet's bets, straight from the contract (no database needed). */
export function useMyBets(owner?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["bets", owner],
    enabled: deployed && !!owner && !!client,
    refetchInterval: 8_000,
    queryFn: async (): Promise<BetRow[]> => {
      const ids = (await client!.readContract({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "betsOf",
        args: [owner!],
      })) as readonly bigint[];
      const recent = [...ids].reverse().slice(0, 200);
      const rows = await Promise.all(
        recent.map(async (id) => {
          const [b, st, cl] = await Promise.all([
            client!.readContract({ address: deployment.book, abi: oddraBookAbi, functionName: "getBet", args: [id] }),
            client!.readContract({
              address: deployment.book,
              abi: oddraBookAbi,
              functionName: "betStatus",
              args: [id],
            }),
            client!.readContract({
              address: deployment.book,
              abi: oddraBookAbi,
              functionName: "claimable",
              args: [id],
            }),
          ]);
          const bet = b as {
            matchId: bigint;
            selection: number;
            odds: number;
            stake: bigint;
            payout: bigint;
            placedAt: bigint;
            paid: boolean;
          };
          return {
            id,
            matchId: bet.matchId,
            selection: bet.selection,
            odds: bet.odds,
            stake: bet.stake,
            payout: bet.payout,
            placedAt: bet.placedAt,
            paid: bet.paid,
            status: BET_STATUS[Number(st)],
            claimable: cl as bigint,
            won: null as boolean | null,
          };
        }),
      );
      const matchIds = [...new Set(rows.map((r) => r.matchId.toString()))];
      const books = await Promise.all(
        matchIds.map((m) =>
          client!.readContract({
            address: deployment.book,
            abi: oddraBookAbi,
            functionName: "bookState",
            args: [BigInt(m)],
          }),
        ),
      );
      const bookOf = new Map(matchIds.map((m, i) => [m, books[i]]));
      for (const r of rows) {
        const [settled, voided, mask] = bookOf.get(r.matchId.toString())!;
        r.won = voided ? false : settled ? ((Number(mask) >>> r.selection) & 1) === 1 : null;
      }
      return rows;
    },
  });
}

export function useTreasury() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["treasury"],
    enabled: deployed && !!client,
    refetchInterval: 10_000,
    queryFn: async () => {
      const fns = [
        "balance",
        "freeBalance",
        "totalReserved",
        "totalStakes",
        "totalPayouts",
        "totalContributed",
        "totalCreatorFees",
        "totalWithdrawn",
      ] as const;
      const vals = await Promise.all(
        fns.map(
          (fn) =>
            client!.readContract({
              address: deployment.treasury,
              abi: oddraTreasuryAbi,
              functionName: fn,
            }) as Promise<bigint>,
        ),
      );
      return Object.fromEntries(fns.map((f, i) => [f, vals[i]])) as Record<(typeof fns)[number], bigint>;
    },
  });
}

/** Events visible at chain time `now` for a match replay. */
export function useVisibleEvents(result: MatchResult | null, kickoff: number | undefined, now: number | null) {
  return useMemo(() => {
    if (!result || kickoff === undefined || now === null) return [];
    const gameSeconds = Math.max(0, (now - kickoff) * 6);
    return result.events.filter((e) => e.tick * 0.1 <= gameSeconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, kickoff, now === null ? null : Math.floor(now)]);
}

/** The last `n` slots before `curId`, read from the registry (works without a database). */
export function useRecentMatches(curId: bigint | null, n = 8) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["recent", curId?.toString(), n],
    enabled: deployed && curId !== null && !!client,
    refetchInterval: 20_000,
    queryFn: async () => {
      const ids = Array.from({ length: n }, (_, i) => curId! - 1n - BigInt(i));
      const ms = await Promise.all(
        ids.map((id) =>
          client!.readContract({
            address: deployment.registry,
            abi: oddraMatchRegistryAbi,
            functionName: "getMatch",
            args: [id],
          }),
        ),
      );
      return ids.map((id, i) => ({ id, m: ms[i] as unknown as OnchainMatch })).filter((x) => x.m.status !== 0);
    },
  });
}
