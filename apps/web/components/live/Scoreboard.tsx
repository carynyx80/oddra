"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { MatchConfig, TeamConfig } from "@oddra/engine";
import { formatClock, type Phase, type Slot } from "@oddra/shared";
import { kits } from "@/components/Pitch";
import { LiveDot } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const textOn = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#050505" : "#ffffff";
};

/** A club badge drawn from its kit: shield in the primary colour, initials, a stripe of the second colour. */
export function Crest({ team, kit, size = 44 }: { team: TeamConfig; kit?: string; size?: number }) {
  const main = kit ?? team.kit[0];
  const trim = main === team.kit[0] ? team.kit[1] : team.kit[0];
  return (
    <svg width={size} height={size} viewBox="0 0 40 44" aria-hidden="true" className="shrink-0">
      <path
        d="M20 2 37 8v13c0 10.5-7 17.5-17 21C10 38.5 3 31.5 3 21V8z"
        fill={main}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1.2"
      />
      <path d="M3 24h34" stroke={trim} strokeWidth="3.2" opacity="0.9" />
      <text
        x="20"
        y="19"
        textAnchor="middle"
        fontSize="10.5"
        fontWeight="700"
        fill={textOn(main)}
        fontFamily="var(--font-geist-sans), system-ui"
        letterSpacing="0.5"
      >
        {team.short}
      </text>
    </svg>
  );
}

/** The 20-minute cycle: 5 minutes of betting, then 15 of live play, with a marker at "now". */
export function CycleBar({ slot, now }: { slot: Slot; now: number }) {
  const total = slot.fullTime - slot.openTime;
  const at = Math.max(0, Math.min(1, (now - slot.openTime) / total));
  const split = (slot.kickoff - slot.openTime) / total;
  const time = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="px-4 pb-3 sm:px-5">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: `${Math.min(at, split) * 100}%` }} />
        <div
          className="absolute inset-y-0 bg-accent"
          style={{ left: `${split * 100}%`, width: `${Math.max(0, at - split) * 100}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-bg" style={{ left: `${split * 100}%` }} />
      </div>
      <div className="num mt-1.5 flex text-[10px] uppercase tracking-wider text-muted">
        <span style={{ width: `${split * 100}%` }}>
          <span className="hidden sm:inline">Betting · </span>
          {time(slot.openTime)}
        </span>
        <span className="flex-1">
          <span className="hidden sm:inline">Kickoff · </span>
          {time(slot.kickoff)}
        </span>
        <span>
          <span className="hidden sm:inline">Full time · </span>
          {time(slot.fullTime)}
        </span>
      </div>
    </div>
  );
}

function Side({ cfg, side, align }: { cfg: MatchConfig; side: 0 | 1; align: "left" | "right" }) {
  const t = side === 0 ? cfg.home : cfg.away;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center sm:flex-row sm:gap-3",
        align === "right" ? "sm:flex-row-reverse sm:text-right" : "sm:text-left",
      )}
    >
      <Crest team={t} kit={kits(cfg)[side]} />
      <div className="min-w-0">
        <div className="font-[family-name:var(--font-display)] text-[13px] font-semibold leading-tight sm:truncate sm:text-[18px]">
          {t.name}
        </div>
        <div className="num hidden truncate text-[11px] text-muted sm:block">
          {t.formation} · strength {t.rating}
        </div>
      </div>
    </div>
  );
}

export interface ScoreboardProps {
  id: bigint;
  cfg: MatchConfig;
  slot: Slot;
  now: number;
  phase: Phase;
  score: [number, number] | null;
  gameSeconds: number;
  revealed: boolean;
  status: string;
  next?: { cfg: MatchConfig; openTime: number } | null;
}

export function Scoreboard({ id, cfg, slot, now, phase, score, gameSeconds, revealed, status, next }: ScoreboardProps) {
  const live = phase === "live" && revealed;
  let caption: React.ReactNode;
  if (phase === "upcoming")
    caption = (
      <>
        Betting opens in <span className="num text-fg">{formatClock(slot.openTime - now)}</span>
      </>
    );
  else if (phase === "betting")
    caption = (
      <>
        Betting closes in <span className="num text-accent">{formatClock(slot.kickoff - now)}</span>
      </>
    );
  else if (phase === "live" && !revealed)
    caption = status === "Voided" ? "Voided · stakes refundable" : "Kickoff · revealing the seed…";
  else if (phase === "live") caption = gameSeconds < 2700 ? "First half" : "Second half";
  else
    caption =
      status === "Settled"
        ? "Full time · settled on-chain"
        : status === "Voided"
          ? "Voided · stakes refundable"
          : status === "Proposed"
            ? "Full time · result final after the dispute window"
            : status === "Disputed"
              ? "Full time · result disputed, awaiting the arbiter"
              : "Full time · settling";

  return (
    <section
      className="overflow-hidden rounded-lg border border-line bg-gradient-to-b from-[#101013] to-card"
      aria-label="Scoreboard"
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3 text-[11px] text-muted sm:px-5">
        <span className="num">Match #{id.toString()}</span>
        {live ? (
          <span className="flex items-center gap-1.5 font-medium text-accent">
            <LiveDot /> LIVE
          </span>
        ) : (
          <span className="uppercase tracking-wider">
            {phase === "betting" ? "Pre-match" : phase === "finished" ? "Full time" : phase}
          </span>
        )}
        {next ? (
          <span className="hidden truncate sm:block">
            Next: {next.cfg.home.short} v {next.cfg.away.short} ·{" "}
            {new Date(next.openTime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : (
          <span className="hidden sm:block">Every 20 minutes</span>
        )}
      </div>
      <div className="flex items-center gap-3 px-4 py-4 sm:gap-6 sm:px-5">
        <Side cfg={cfg} side={0} align="left" />
        <div className="flex shrink-0 flex-col items-center">
          <div className="num flex items-center gap-2 font-[family-name:var(--font-display)] text-[34px] font-bold leading-none sm:text-[44px]">
            {score ? (
              <>
                <AnimatePresence mode="popLayout">
                  <motion.span
                    key={`h${score[0]}`}
                    initial={{ y: -14, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 14, opacity: 0 }}
                  >
                    {score[0]}
                  </motion.span>
                </AnimatePresence>
                <span className="text-muted/60">:</span>
                <AnimatePresence mode="popLayout">
                  <motion.span
                    key={`a${score[1]}`}
                    initial={{ y: -14, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 14, opacity: 0 }}
                  >
                    {score[1]}
                  </motion.span>
                </AnimatePresence>
              </>
            ) : (
              <span className="text-[22px] text-muted sm:text-[26px]">vs</span>
            )}
          </div>
          <div className="num mt-1.5 rounded bg-raised px-2 py-0.5 text-[12px] font-semibold">
            {live ? (
              <span className="text-accent">{Math.min(90, Math.floor(gameSeconds / 60) + 1)}&apos;</span>
            ) : phase === "finished" ? (
              "FT"
            ) : (
              formatClock(Math.max(0, (phase === "upcoming" ? slot.openTime : slot.kickoff) - now))
            )}
          </div>
        </div>
        <Side cfg={cfg} side={1} align="right" />
      </div>
      <div className="px-4 pb-2 text-center text-[12px] text-muted sm:px-5">{caption}</div>
      <CycleBar slot={slot} now={now} />
    </section>
  );
}
