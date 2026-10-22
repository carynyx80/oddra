"use client";

import { useEffect, useRef, useState } from "react";
import { MARKETS, SELECTIONS, formatOdds, selectionWins, type MarketKey } from "@oddra/shared";
import { Badge, Tabs } from "@/components/ui/primitives";
import { useSlip } from "@/lib/slip";
import { cn } from "@/lib/utils";

const COLS: Record<MarketKey, string> = {
  result: "grid-cols-3",
  doubleChance: "grid-cols-3",
  totals: "grid-cols-2",
  btts: "grid-cols-2",
  firstScorer: "grid-cols-3",
  correctScore: "grid-cols-4",
};

type Group = "main" | "goals" | "score";
const GROUPS: Record<Group, MarketKey[]> = {
  main: ["result", "doubleChance"],
  goals: ["totals", "btts", "firstScorer"],
  score: ["correctScore"],
};

/** Remembers the last price per selection so a change can flash up or down. */
function usePriceMoves(odds: number[]) {
  const prev = useRef<number[] | null>(null);
  const [moves, setMoves] = useState<Record<number, "up" | "down">>({});
  useEffect(() => {
    const p = prev.current;
    if (p) {
      const m: Record<number, "up" | "down"> = {};
      odds.forEach((o, i) => {
        if (p[i] && o && o !== p[i]) m[i] = o > p[i] ? "up" : "down";
      });
      if (Object.keys(m).length) {
        setMoves(m);
        const t = setTimeout(() => setMoves({}), 4_000);
        prev.current = odds;
        return () => clearTimeout(t);
      }
    }
    prev.current = odds;
  }, [odds]);
  return moves;
}

/**
 * Odds board in three tabs. `open` = betting window running. When closed it shows the prices that applied, locked,
 * and after settlement marks the winning selections.
 */
export function Markets({
  matchId,
  odds,
  open,
  winMask,
  homeShort,
  awayShort,
}: {
  matchId: bigint;
  odds: number[];
  open: boolean;
  winMask?: number | null;
  homeShort: string;
  awayShort: string;
}) {
  const { pick, setPick } = useSlip();
  const [group, setGroup] = useState<Group>("main");
  const moves = usePriceMoves(odds);
  const label = (id: number, l: string) => (id === 0 || id === 10 ? homeShort : id === 2 || id === 11 ? awayShort : l);
  const published = odds.some((o) => o > 0);
  return (
    <div>
      <div className="flex items-center justify-between pr-3">
        <Tabs
          value={group}
          onChange={setGroup}
          tabs={[
            { key: "main", label: "Main" },
            { key: "goals", label: "Goals" },
            { key: "score", label: "Correct score" },
          ]}
        />
        {open ? <Badge tone="accent">Open</Badge> : <Badge>{winMask != null ? "Settled" : "Locked"}</Badge>}
      </div>
      {!published ? (
        <p className="p-4 text-[13px] text-muted">
          Pricing this match… odds appear as soon as they are published on-chain.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {MARKETS.filter((m) => GROUPS[group].includes(m.key)).map((m) => (
            <div key={m.key} className="px-4 py-3">
              <div className="label mb-2">{m.title}</div>
              <div className={cn("grid gap-1.5", COLS[m.key])}>
                {SELECTIONS.filter((s) => s.market === m.key).map((s) => {
                  const o = odds[s.id];
                  const selected = pick?.matchId === matchId && pick.selection === s.id;
                  const won = winMask != null && selectionWins(winMask, s.id);
                  const disabled = !open || o === 0;
                  const move = moves[s.id];
                  return (
                    <button
                      key={s.id}
                      disabled={disabled}
                      onClick={() => setPick(selected ? null : { matchId, selection: s.id, odds: o })}
                      aria-pressed={selected}
                      title={o ? `Implied probability ${(10_000 / o).toFixed(1)}%` : "Suspended"}
                      className={cn(
                        "group relative flex min-h-12 flex-col items-center justify-center rounded-md border px-1 py-1.5 transition-all",
                        selected
                          ? "border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(184,255,101,0.35)]"
                          : "border-line bg-raised",
                        !disabled && !selected && "hover:-translate-y-px hover:border-[#4a4a54] hover:bg-[#222228]",
                        disabled && "cursor-default",
                        won && "border-pos/60 bg-pos/10",
                        winMask != null && !won && "opacity-45",
                      )}
                    >
                      <span className="max-w-full truncate text-[11px] text-muted">{label(s.id, s.label)}</span>
                      <span
                        className={cn(
                          "num text-[15px] font-semibold transition-colors",
                          selected
                            ? "text-accent"
                            : won
                              ? "text-pos"
                              : move === "up"
                                ? "text-pos"
                                : move === "down"
                                  ? "text-neg"
                                  : "text-fg",
                        )}
                      >
                        {o === 0 ? "–" : formatOdds(o)}
                        {move ? <span className="ml-0.5 text-[10px]">{move === "up" ? "▲" : "▼"}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
