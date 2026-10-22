"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GAME_SECONDS_PER_REAL_SECOND } from "@oddra/engine";
import { formatClock, isRevealed, phaseOf, slot } from "@oddra/shared";
import { LiveDot } from "@/components/ui/primitives";
import { useSchedule, useSimulation, useVisibleEvents } from "@/lib/hooks";
import { configFor } from "@/lib/match";

/** Current match at a glance in the header, on every page except the Live page itself. */
export function LiveTicker() {
  const path = usePathname();
  const { now, current } = useSchedule();
  const v = current.data && current.data.status !== "None" ? current.data : null;
  const revealed = !!v && isRevealed(v.m.status);
  const { result } = useSimulation(v?.id, v?.m.homeTeam, v?.m.awayTeam, revealed ? v!.m.finalSeed : undefined);
  const s = v ? slot(v.id) : null;
  const events = useVisibleEvents(result, s?.kickoff, now);
  if (path === "/" || !v || !s || now === null) return null;
  const cfg = configFor(v.id, v.m.homeTeam, v.m.awayTeam);
  if (!cfg) return null;
  const phase = phaseOf(s, now);
  const last = events[events.length - 1];
  const minute = Math.min(90, Math.floor(((now - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND) / 60) + 1);
  return (
    <Link
      href="/"
      className="hidden items-center gap-2 rounded-md border border-line bg-card px-2.5 py-1 text-[12px] hover:border-[#3a3a42] md:flex"
    >
      {phase === "live" ? <LiveDot /> : null}
      <span>{cfg.home.short}</span>
      <span className="num font-semibold">
        {phase === "live" || phase === "finished" ? `${last?.home ?? 0}-${last?.away ?? 0}` : "v"}
      </span>
      <span>{cfg.away.short}</span>
      <span className="num text-muted">
        {phase === "live"
          ? revealed
            ? `${minute}'`
            : "KO"
          : phase === "betting"
            ? `bets ${formatClock(s.kickoff - now)}`
            : phase === "finished"
              ? "FT"
              : ""}
      </span>
    </Link>
  );
}
