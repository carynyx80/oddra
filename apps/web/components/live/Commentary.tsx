"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { MatchConfig, MatchEvent } from "@oddra/engine";
import { commentary } from "@oddra/shared";
import { kits } from "@/components/Pitch";
import { Empty } from "@/components/ui/primitives";
import { minuteOf } from "@/lib/match";
import { cn } from "@/lib/utils";

const TAG: Partial<Record<MatchEvent["type"], string>> = {
  goal: "GOAL",
  save: "SAVE",
  shot: "SHOT",
  corner: "CRN",
  foul: "FOUL",
  penalty: "PEN",
  free_kick: "FK",
  halftime: "HT",
  fulltime: "FT",
  kickoff: "KO",
  tackle: "TKL",
  interception: "INT",
  block: "BLK",
};

/** Live text commentary, newest first; each line carries its team's colour and goals stand out. */
export function Commentary({ cfg, events, max = 40 }: { cfg: MatchConfig; events: MatchEvent[]; max?: number }) {
  const [hk, ak] = kits(cfg);
  const lines = events
    .map((e) => ({ e, text: commentary(cfg, e) }))
    .filter((x) => x.text)
    .slice(-max)
    .reverse();
  if (lines.length === 0) return <Empty>Commentary starts at kickoff.</Empty>;
  return (
    <ul className="max-h-72 overflow-y-auto" aria-live="polite">
      <AnimatePresence initial={false}>
        {lines.map(({ e, text }) => {
          const goal = e.type === "goal";
          return (
            <motion.li
              key={e.seq}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={cn(
                "relative flex gap-3 border-b border-line px-4 py-2 text-[13px]",
                goal && "bg-accent/[0.07]",
              )}
            >
              <span
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-r"
                style={{ background: e.team === 0 ? hk : e.team === 1 ? ak : "transparent" }}
              />
              <span className="num w-8 shrink-0 text-muted">{minuteOf(e.tick)}&apos;</span>
              <span
                className={cn(
                  "w-10 shrink-0 pt-px text-[10px] font-semibold tracking-wider",
                  goal ? "text-accent" : "text-muted",
                )}
              >
                {TAG[e.type] ?? ""}
              </span>
              <span className={goal ? "font-semibold text-fg" : "text-[#d4d4da]"}>{text}</span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
