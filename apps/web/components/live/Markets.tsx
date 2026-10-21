"use client";

import { MARKETS, SELECTIONS, formatOdds, selectionWins, type MarketKey } from "@oddra/shared";
import { Card, CardHeader, Badge } from "@/components/ui/primitives";
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

/**
 * Odds board. `open` = betting window running. When closed it shows the prices that applied, locked, and after
 * settlement marks the winning selections.
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
  const label = (id: number, l: string) => (id === 0 || id === 10 ? homeShort : id === 2 || id === 11 ? awayShort : l);
  const published = odds.some((o) => o > 0);
  return (
    <Card>
      <CardHeader
        title="Markets"
        right={open ? <Badge tone="accent">Open</Badge> : <Badge>{winMask != null ? "Settled" : "Locked"}</Badge>}
      />
      {!published ? (
        <p className="p-4 text-[13px] text-muted">
          Pricing this match… odds appear as soon as they are published on-chain.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {MARKETS.map((m) => (
            <div key={m.key} className="px-4 py-3">
              <div className="label mb-2">{m.title}</div>
              <div className={cn("grid gap-1.5", COLS[m.key])}>
                {SELECTIONS.filter((s) => s.market === m.key).map((s) => {
                  const o = odds[s.id];
                  const selected = pick?.matchId === matchId && pick.selection === s.id;
                  const won = winMask != null && selectionWins(winMask, s.id);
                  const disabled = !open || o === 0;
                  return (
                    <button
                      key={s.id}
                      disabled={disabled}
                      onClick={() => setPick(selected ? null : { matchId, selection: s.id, odds: o })}
                      aria-pressed={selected}
                      className={cn(
                        "flex min-h-11 flex-col items-center justify-center rounded-md border px-1 py-1.5 transition-colors",
                        selected ? "border-accent bg-accent/10" : "border-line bg-raised",
                        !disabled && !selected && "hover:border-[#3d3d46]",
                        disabled && "cursor-default",
                        won && "border-pos/60 bg-pos/10",
                        winMask != null && !won && "opacity-50",
                      )}
                    >
                      <span className="max-w-full truncate text-[11px] text-muted">{label(s.id, s.label)}</span>
                      <span
                        className={cn(
                          "num text-[14px] font-semibold",
                          selected ? "text-accent" : won ? "text-pos" : "text-fg",
                        )}
                      >
                        {o === 0 ? "–" : formatOdds(o)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
