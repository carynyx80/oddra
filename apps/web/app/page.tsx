"use client";

import { useMemo } from "react";
import { GAME_SECONDS_PER_REAL_SECOND } from "@oddra/engine";
import { formatClock, phaseOf, slot } from "@oddra/shared";
import { Pitch } from "@/components/Pitch";
import { BetSlip } from "@/components/live/BetSlip";
import { Markets } from "@/components/live/Markets";
import { Commentary, MatchHeader, RecentResults, StatsPanel, Timeline } from "@/components/live/Panels";
import { Badge, Card, CardHeader, Empty } from "@/components/ui/primitives";
import { deployed } from "@/lib/config";
import { chainNowSync, useLiveFeed, useRecentMatches, useSchedule, useSimulation, useVisibleEvents } from "@/lib/hooks";
import { configFor, minuteOf, previewFrame, statsAt } from "@/lib/match";
import { useSlip } from "@/lib/slip";
import { useEffect } from "react";

export default function LivePage() {
  const { now, curId, current, next } = useSchedule();
  const feed = useLiveFeed(curId);
  const recent = useRecentMatches(curId, 6);

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
  const revealed = featured ? featured.m.status >= 3 && featured.m.status !== 5 : false;
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
  const recentGoal = last?.type === "goal" && gameSeconds - last.tick * 0.1 < 24 ? last : null;
  const betting = phase === "betting" && featured?.status === "Scheduled";
  // a pick only lives while its market is open
  const clearPick = useSlip((x) => x.setPick);
  useEffect(() => {
    if (!betting) clearPick(null);
  }, [betting, clearPick]);

  let phaseLabel = "";
  let clock: string | null = null;
  let note: string | null = null;
  if (s && now !== null && featured) {
    if (phase === "upcoming") {
      phaseLabel = "Betting opens in";
      clock = formatClock(s.openTime - now);
    } else if (phase === "betting") {
      phaseLabel = "Betting closes in";
      clock = formatClock(s.kickoff - now);
    } else if (phase === "live") {
      phaseLabel = "Live";
      clock = formatClock(s.fullTime - now);
      if (!revealed)
        note =
          featured.status === "Voided"
            ? "This match was voided: every stake is refundable."
            : "Betting closed. Waiting for the entropy block and the seed reveal…";
    } else {
      phaseLabel =
        featured.status === "Settled"
          ? "Full time · settled"
          : featured.status === "Voided"
            ? "Voided · stakes refundable"
            : "Full time · settling";
      clock = null;
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

  return (
    <div className="space-y-4">
      {safeState ? (
        <div className="rounded-md border border-warn/30 bg-warn/5 px-4 py-2.5 text-[13px] text-warn" role="status">
          {safeState}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {featured && cfg ? (
            <MatchHeader
              id={featured.id}
              cfg={cfg}
              phaseLabel={phaseLabel}
              clock={clock}
              score={score}
              minute={phase === "live" ? Math.min(90, Math.floor(gameSeconds / 60) + 1) : null}
              live={phase === "live" && revealed}
              note={note}
            />
          ) : (
            <Card>
              <Empty>{now === null ? "Syncing with the chain…" : "Waiting for the next match to be committed…"}</Empty>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="relative">
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
              {cfg && score ? (
                <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-md bg-black/70 px-2.5 py-1.5 text-[13px] backdrop-blur">
                  <span>{cfg.home.short}</span>
                  <span className="num font-semibold">
                    {score[0]}–{score[1]}
                  </span>
                  <span>{cfg.away.short}</span>
                  {phase === "live" ? (
                    <span className="num ml-1 text-accent">{minuteOf(gameSeconds * 10)}&apos;</span>
                  ) : (
                    <span className="ml-1 text-muted">FT</span>
                  )}
                </div>
              ) : null}
              {phase === "betting" || phase === "upcoming" ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center">
                  <span className="rounded-md bg-black/70 px-3 py-1.5 text-[12px] text-muted backdrop-blur">
                    Line-ups · {phase === "upcoming" ? "betting opens" : "kickoff"} in {clock ?? "–"}
                  </span>
                </div>
              ) : null}
              {recentGoal && cfg ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="rounded-md border border-accent/50 bg-black/80 px-6 py-3 text-center backdrop-blur">
                    <div className="font-[family-name:var(--font-display)] text-[28px] font-bold tracking-[0.2em] text-accent">
                      GOAL
                    </div>
                    <div className="text-[13px]">{recentGoal.team === 0 ? cfg.home.name : cfg.away.name}</div>
                  </div>
                </div>
              ) : null}
            </div>
            {cfg ? (
              <div className="border-t border-line">
                <CardHeader
                  title="Commentary"
                  right={feed.connected ? <Badge tone="accent">Live feed</Badge> : <Badge>Local replay</Badge>}
                  className="border-b-0"
                />
                <Commentary cfg={cfg} events={events} />
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2 xl:col-span-1">
          {featured && cfg ? (
            <>
              {!betting && phase !== "upcoming" ? (
                <div className="rounded-md border border-line bg-card px-4 py-3 text-[13px] text-muted">
                  Markets are locked. Betting reopens for the next match when this one ends.
                </div>
              ) : null}
              {betting ? (
                <BetSlip open={betting} currentOdds={featured.odds} homeName={cfg.home.name} awayName={cfg.away.name} />
              ) : null}
              <Markets
                matchId={featured.id}
                odds={featured.odds}
                open={betting}
                winMask={featured.book.settled ? featured.book.winMask : null}
                homeShort={cfg.home.short}
                awayShort={cfg.away.short}
              />
            </>
          ) : null}
        </div>
      </div>

      {cfg ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <StatsPanel cfg={cfg} stats={stats} />
          <div className="space-y-4">
            <Timeline cfg={cfg} events={events} />
            <RecentResults
              rows={(recent.data ?? []).map((r) => ({
                id: r.id,
                home: r.m.homeTeam,
                away: r.m.awayTeam,
                homeGoals: r.m.homeGoals,
                awayGoals: r.m.awayGoals,
                status: ["None", "Scheduled", "Locked", "Revealed", "Settled", "Voided"][r.m.status],
                cfg: configFor(r.id, r.m.homeTeam, r.m.awayTeam),
              }))}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
