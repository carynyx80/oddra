"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { hasResult, phaseOf, slot } from "@oddra/shared";
import { Badge, Card, CardHeader, Empty, LiveDot } from "@/components/ui/primitives";
import { STATUS, useRecentMatches, useSchedule, type MatchView } from "@/lib/hooks";
import { configFor } from "@/lib/match";

const time = (s: number) =>
  new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Row({
  id,
  home,
  away,
  status,
  score,
  now,
  bookSettled,
}: {
  id: bigint;
  home: number;
  away: number;
  status: string;
  score: string;
  now: number | null;
  bookSettled?: boolean;
}) {
  const cfg = configFor(id, home, away);
  const s = slot(id);
  const phase = now !== null ? phaseOf(s, now) : null;
  return (
    <Link
      href={`/matches/${id}`}
      className="grid grid-cols-[90px_1fr_60px_1fr] items-center gap-3 px-4 py-3 text-[13px] hover:bg-raised sm:grid-cols-[110px_140px_1fr_60px_1fr_150px]"
    >
      <span className="num text-muted">#{id.toString()}</span>
      <span className="num hidden text-muted sm:block">{time(s.kickoff)}</span>
      <span className="truncate text-right">{cfg?.home.name}</span>
      <span className="num text-center font-semibold">{score}</span>
      <span className="truncate">{cfg?.away.name}</span>
      <span className="hidden justify-end gap-1.5 sm:flex">
        {phase === "live" && status !== "Voided" ? (
          <Badge tone="accent">
            <LiveDot /> Live
          </Badge>
        ) : phase === "betting" ? (
          <Badge tone="accent">Betting open</Badge>
        ) : (
          <Badge tone={status === "Settled" ? "pos" : status === "Voided" || status === "Disputed" ? "warn" : "muted"}>
            {status}
          </Badge>
        )}
        {status === "Settled" ? (
          <Badge tone={bookSettled ? "pos" : "muted"}>{bookSettled ? "Paid out" : "Settling"}</Badge>
        ) : null}
      </span>
    </Link>
  );
}

export default function MatchesPage() {
  const { now, curId, current, next } = useSchedule();
  const recent = useRecentMatches(curId, 24);
  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => fetch("/api/matches?limit=60").then((r) => r.json()),
    refetchInterval: 30_000,
  });
  const recentIds = new Set((recent.data ?? []).map((r) => r.id.toString()));
  const older = history.data?.available
    ? (
        history.data.matches as {
          id: string;
          homeTeamId: number;
          awayTeamId: number;
          status: string;
          homeGoals: number | null;
          awayGoals: number | null;
        }[]
      ).filter((m) => !recentIds.has(m.id) && (curId === null || BigInt(m.id) < curId))
    : [];
  const top = [next.data, current.data].filter((m): m is MatchView => !!m && m.status !== "None");

  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Matches</h1>
      <Card>
        <CardHeader
          title="Current and upcoming"
          right={<span className="text-[12px] text-muted">One match live at a time · every 20 minutes</span>}
        />
        {top.length === 0 ? (
          <Empty>
            No match is scheduled yet. The next one is committed automatically before its betting window opens.
          </Empty>
        ) : (
          <div className="divide-y divide-line">
            {top.map((m) => (
              <Row
                key={m.id.toString()}
                id={m.id}
                home={m.m.homeTeam}
                away={m.m.awayTeam}
                status={m.status}
                score="v"
                now={now}
              />
            ))}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Previous results"
          right={<span className="text-[12px] text-muted">Every result is reproducible from on-chain data</span>}
        />
        {(recent.data ?? []).length === 0 && older.length === 0 ? (
          <Empty>No completed matches yet.</Empty>
        ) : (
          <div className="divide-y divide-line">
            {(recent.data ?? []).map((r) => (
              <Row
                key={r.id.toString()}
                id={r.id}
                home={r.m.homeTeam}
                away={r.m.awayTeam}
                status={STATUS[r.m.status]}
                score={hasResult(r.m.status) ? `${r.m.homeGoals}-${r.m.awayGoals}` : "–"}
                now={now}
              />
            ))}
            {older.map((m) => (
              <Row
                key={m.id}
                id={BigInt(m.id)}
                home={m.homeTeamId}
                away={m.awayTeamId}
                status={m.status === "SETTLED" ? "Settled" : "Voided"}
                score={m.homeGoals !== null ? `${m.homeGoals}-${m.awayGoals}` : "–"}
                now={now}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
