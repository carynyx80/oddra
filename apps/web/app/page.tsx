"use client";

import { useMemo } from "react";
import { GAME_SECONDS_PER_REAL_SECOND } from "@oddra/engine";
import { formatClock, isRevealed, phaseOf, slot } from "@oddra/shared";
import { Pitch } from "@/components/Pitch";
import { BettingRail, NextUp, ProofCard } from "@/components/live/BettingRail";
import { EventToast, MatchTabs, Momentum, PossessionBar, ResultsStrip } from "@/components/live/MatchCentre";
import { Scoreboard } from "@/components/live/Scoreboard";
import { Badge, Card, Empty } from "@/components/ui/primitives";
import { deployed } from "@/lib/config";
import {
  STATUS,
  chainNowSync,
  useLiveFeed,
  useRecentMatches,
  useSchedule,
  useSimulation,
  useVisibleEvents,
} from "@/lib/hooks";
import { configFor, previewFrame, statsAt } from "@/lib/match";
import { useSlip } from "@/lib/slip";
import { useEffect } from "react";

export default function LivePage() {
  const { now, curId, current, next } = useSchedule();
  const feed = useLiveFeed(curId);
  const recent = useRecentMatches(curId, 8);

  // feature the current slot's match, or the next one while the current slot is empty
  const featured =
    current.data && current.data.status !== "None"
      ? current.data
      : next.data && next.data.status !== "None"
        ? next.data
        : null;
  const id = featured?.id ?? null;
  const s = id !== null ? slot(id) : null;
  const phase = s && now !== null ? phaseOf(s, now) : null;
  const cfg = featured ? configFor(featured.id, featured.m.homeTeam, featured.m.awayTeam) : null;
  const revealed = featured ? isRevealed(featured.m.status) : false;
  const { result } = useSimulation(
    id,
    featured?.m.homeTeam,
    featured?.m.awayTeam,
    revealed ? featured!.m.finalSeed : undefined,
  );
  const events = useVisibleEvents(result, s?.kickoff, now);
  const gameSeconds =
    s && now !== null ? Math.max(0, Math.min(5400, (now - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND)) : 0;
  const second = Math.floor(gameSeconds);
  const stats = useMemo(
    () => (result && phase !== "betting" && phase !== "upcoming" ? statsAt(result, second) : null),
    [result, phase, second],
  );
  const preview = useMemo(() => (cfg ? previewFrame(cfg) : null), [cfg]);

  const last = events[events.length - 1];
  const score: [number, number] | null =
    phase === "live" || phase === "finished" ? (last ? [last.home, last.away] : [0, 0]) : null;
  const betting = phase === "betting" && featured?.status === "Scheduled";
  // a pick only lives while its market is open
  const clearPick = useSlip((x) => x.setPick);
  useEffect(() => {
    if (!betting) clearPick(null);
  }, [betting, clearPick]);

  let clock: string | null = null;
  let note: string | null = null;
  if (s && now !== null && featured) {
    if (phase === "upcoming") clock = formatClock(s.openTime - now);
    else if (phase === "betting") clock = formatClock(s.kickoff - now);
    else if (phase === "live") {
      clock = formatClock(s.fullTime - now);
      if (!revealed)
        note =
          featured.status === "Voided"
            ? "This match was voided: every stake is refundable."
            : "Betting closed. Waiting for the entropy block and the seed reveal…";
    }
  }

  const safeState =
    feed.safeState ??
    (current.data?.status === "None" && (!next.data || next.data.status === "None")
      ? "No match is scheduled right now. The next one is created automatically before its betting window."
      : null);

  if (!deployed)
    return (
      <Card>
        <Empty>Contracts are not configured.</Empty>
      </Card>
    );

  const nextCfg =
    featured && next.data && next.data.id !== featured.id && next.data.status !== "None"
      ? {
          cfg: configFor(next.data.id, next.data.m.homeTeam, next.data.m.awayTeam)!,
          openTime: slot(next.data.id).openTime,
        }
      : null;
  const prematch = phase === "betting" || phase === "upcoming";

  return (
    <div className="space-y-4">
      {safeState ? (
        <div className="rounded-md border border-warn/30 bg-warn/5 px-4 py-2.5 text-[13px] text-warn" role="status">
          {safeState}
        </div>
      ) : null}

      {featured && cfg && s && now !== null && phase ? (
        <Scoreboard
          id={featured.id}
          cfg={cfg}
          slot={s}
          now={now}
          phase={phase}
          score={score}
          gameSeconds={gameSeconds}
          revealed={revealed}
          status={featured.status}
          next={nextCfg}
        />
      ) : (
        <Card>
          <Empty>{now === null ? "Syncing with the chain…" : "Waiting for the next match to be committed…"}</Empty>
        </Card>
      )}

      {featured && cfg ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="overflow-hidden xl:col-start-1">
            <div className="relative bg-[#070d09]">
              <Pitch
                config={cfg}
                result={phase === "live" || phase === "finished" ? result : null}
                preview={preview}
                gameSeconds={() => {
                  const n = chainNowSync();
                  return s && n !== null
                    ? Math.max(0, Math.min(5400, (n - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND))
                    : 0;
                }}
              />
              {phase === "live" || phase === "finished" ? (
                <EventToast cfg={cfg} events={events} gameSeconds={gameSeconds} />
              ) : null}
              {prematch && clock ? (
                <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-5 sm:items-center sm:pb-0">
                  <div className="rounded-xl border border-line bg-black/75 px-5 py-3 text-center backdrop-blur-md">
                    <div className="label">{phase === "upcoming" ? "Betting opens in" : "Kickoff in"}</div>
                    <div className="num mt-1 font-[family-name:var(--font-display)] text-[30px] font-bold leading-none sm:text-[38px]">
                      {phase === "upcoming" ? clock : formatClock(s!.kickoff - (now ?? 0))}
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted">Line-ups shown in kickoff positions</div>
                  </div>
                </div>
              ) : null}
              {phase === "live" && !revealed ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="rounded-xl border border-line bg-black/80 px-5 py-3 text-center text-[13px] text-muted backdrop-blur-md">
                    {note}
                  </div>
                </div>
              ) : null}
            </div>
            {phase === "live" || phase === "finished" ? (
              <div className="border-t border-line">
                <PossessionBar cfg={cfg} stats={stats} />
                <div className="border-t border-line">
                  <Momentum cfg={cfg} result={result} gameSeconds={gameSeconds} />
                </div>
              </div>
            ) : null}
          </Card>

          <div className="space-y-3 self-start xl:sticky xl:top-[72px] xl:col-start-2 xl:row-span-2 xl:row-start-1">
            <BettingRail
              match={featured}
              cfg={cfg}
              betting={betting}
              closesIn={betting && s && now !== null ? s.kickoff - now : null}
              phaseNote={
                phase === "upcoming"
                  ? "Opens soon"
                  : phase === "finished"
                    ? featured.book.settled
                      ? "Settled"
                      : featured.status === "Proposed"
                        ? "Final soon"
                        : featured.status === "Disputed"
                          ? "Disputed"
                          : "Settling"
                    : "Locked"
              }
            />
            {!betting && nextCfg && now !== null ? (
              <NextUp cfg={nextCfg.cfg} openTime={nextCfg.openTime} now={now} />
            ) : null}
            <ProofCard match={featured} />
          </div>

          <Card className="overflow-hidden xl:col-start-1">
            <MatchTabs
              cfg={cfg}
              events={events}
              stats={stats}
              result={phase === "live" || phase === "finished" ? result : null}
              liveBadge={feed.connected ? <Badge tone="accent">Live feed</Badge> : <Badge>Local replay</Badge>}
            />
          </Card>
        </div>
      ) : null}

      <ResultsStrip
        rows={(recent.data ?? []).map((r) => ({
          id: r.id,
          cfg: configFor(r.id, r.m.homeTeam, r.m.awayTeam),
          homeGoals: r.m.homeGoals,
          awayGoals: r.m.awayGoals,
          status: STATUS[r.m.status],
        }))}
      />
    </div>
  );
}
