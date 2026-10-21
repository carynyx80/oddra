"use client";

import Link from "next/link";
import type { MatchConfig, MatchEvent, MatchResult, TeamStats } from "@oddra/engine";
import { commentary, formatClock } from "@oddra/shared";
import { Badge, Card, CardHeader, Empty, LiveDot } from "@/components/ui/primitives";
import { kits } from "@/components/Pitch";
import { minuteOf } from "@/lib/match";
import { cn } from "@/lib/utils";

export function TeamLine({ cfg, side }: { cfg: MatchConfig; side: 0 | 1 }) {
  const t = side === 0 ? cfg.home : cfg.away;
  const kit = kits(cfg)[side];
  return (
    <div className="flex items-center gap-3">
      <span className="h-3 w-3 shrink-0 rounded-full border border-black/50" style={{ background: kit }} />
      <div className="min-w-0">
        <div className="truncate text-[15px] font-medium">{t.name}</div>
        <div className="num text-[11px] text-muted">
          {t.formation} · strength {t.rating}
        </div>
      </div>
    </div>
  );
}

export function MatchHeader({
  id,
  cfg,
  phaseLabel,
  clock,
  score,
  minute,
  live,
  note,
}: {
  id: bigint;
  cfg: MatchConfig;
  phaseLabel: string;
  clock: string | null;
  score: [number, number] | null;
  minute: number | null;
  live: boolean;
  note?: string | null;
}) {
  return (
    <Card>
      <CardHeader
        title={<span className="num">Match #{id.toString()}</span>}
        right={
          live ? (
            <Badge tone="accent">
              <LiveDot /> Live
            </Badge>
          ) : (
            <Badge>{phaseLabel}</Badge>
          )
        }
      />
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <TeamLine cfg={cfg} side={0} />
          <span className="num font-[family-name:var(--font-display)] text-[28px] font-semibold">
            {score ? score[0] : ""}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <TeamLine cfg={cfg} side={1} />
          <span className="num font-[family-name:var(--font-display)] text-[28px] font-semibold">
            {score ? score[1] : ""}
          </span>
        </div>
        <div className="flex items-end justify-between border-t border-line pt-3">
          <div>
            <div className="label">{live ? "Match minute" : phaseLabel}</div>
            <div className="num mt-1 font-[family-name:var(--font-display)] text-[26px] font-semibold">
              {live && minute !== null ? `${minute}'` : (clock ?? "–")}
            </div>
          </div>
          {live && clock ? <div className="num text-right text-[12px] text-muted">ends in {clock}</div> : null}
        </div>
        {note ? <p className="text-[12px] text-muted">{note}</p> : null}
      </div>
    </Card>
  );
}

const ICON: Partial<Record<MatchEvent["type"], string>> = {
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

export function Commentary({ cfg, events, max = 40 }: { cfg: MatchConfig; events: MatchEvent[]; max?: number }) {
  const lines = events
    .map((e) => ({ e, text: commentary(cfg, e) }))
    .filter((x) => x.text)
    .slice(-max)
    .reverse();
  return (
    <div className="max-h-64 overflow-y-auto" aria-live="polite">
      {lines.length === 0 ? (
        <Empty>Commentary starts at kickoff.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {lines.map(({ e, text }) => (
            <li key={e.seq} className="flex gap-3 px-4 py-2 text-[13px]">
              <span className="num w-8 shrink-0 text-muted">{minuteOf(e.tick)}&apos;</span>
              <span
                className={cn(
                  "w-10 shrink-0 text-[10px] font-semibold tracking-wider",
                  e.type === "goal" ? "text-accent" : "text-muted",
                )}
              >
                {ICON[e.type] ?? ""}
              </span>
              <span className={e.type === "goal" ? "font-medium text-fg" : "text-[#d4d4da]"}>{text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROWS: { key: keyof TeamStats; label: string; pct?: boolean }[] = [
  { key: "possession", label: "Possession", pct: true },
  { key: "shots", label: "Shots" },
  { key: "shotsOnTarget", label: "On target" },
  { key: "corners", label: "Corners" },
  { key: "fouls", label: "Fouls" },
  { key: "saves", label: "Saves" },
  { key: "passes", label: "Passes" },
  { key: "tackles", label: "Tackles won" },
];

export function StatsPanel({ cfg, stats }: { cfg: MatchConfig; stats: [TeamStats, TeamStats] | null }) {
  const [hk, ak] = kits(cfg);
  return (
    <Card>
      <CardHeader title="Statistics" right={<span className="text-[11px] text-muted">from simulated events</span>} />
      {!stats ? (
        <Empty>Statistics appear once the match kicks off.</Empty>
      ) : (
        <div className="space-y-3 p-4">
          {ROWS.map((r) => {
            const a = stats[0][r.key] as number;
            const b = stats[1][r.key] as number;
            const total = a + b || 1;
            const acc = r.key === "passes";
            return (
              <div key={r.key}>
                <div className="num mb-1 flex justify-between text-[12px]">
                  <span>
                    {r.pct ? `${a.toFixed(0)}%` : a}
                    {acc && stats[0].passes ? (
                      <span className="text-muted">
                        {" "}
                        ({Math.round((stats[0].passesCompleted / stats[0].passes) * 100)}%)
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted">{r.label}</span>
                  <span>
                    {acc && stats[1].passes ? (
                      <span className="text-muted">
                        ({Math.round((stats[1].passesCompleted / stats[1].passes) * 100)}%){" "}
                      </span>
                    ) : null}
                    {r.pct ? `${b.toFixed(0)}%` : b}
                  </span>
                </div>
                <div className="flex h-1 gap-0.5 overflow-hidden rounded">
                  <div style={{ width: `${(a / total) * 100}%`, background: hk }} />
                  <div style={{ width: `${(b / total) * 100}%`, background: ak }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function Timeline({ cfg, events }: { cfg: MatchConfig; events: MatchEvent[] }) {
  const key = events.filter(
    (e) => e.type === "goal" || e.type === "penalty" || e.type === "halftime" || (e.type === "save" && e.seq % 2 === 0),
  );
  return (
    <Card>
      <CardHeader title="Timeline" />
      <div className="relative px-4 py-6">
        <div className="relative h-1 rounded bg-raised">
          <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        </div>
        {key.map((e) => {
          const pct = Math.min(100, (e.tick / 54_000) * 100);
          const up = e.team === 0;
          return (
            <div
              key={e.seq}
              className="absolute"
              style={{ left: `calc(1rem + (100% - 2rem) * ${pct / 100})`, top: up ? "0.35rem" : "2.1rem" }}
              title={commentary(cfg, e) ?? e.type}
            >
              <span
                className={cn(
                  "block -translate-x-1/2 rounded px-1 text-[10px] font-semibold",
                  e.type === "goal"
                    ? "bg-accent text-black"
                    : e.type === "halftime"
                      ? "text-muted"
                      : "bg-raised text-muted",
                )}
              >
                {e.type === "goal"
                  ? `${minuteOf(e.tick)}'`
                  : e.type === "halftime"
                    ? "HT"
                    : e.type === "penalty"
                      ? "P"
                      : "·"}
              </span>
            </div>
          );
        })}
        <div className="num mt-6 flex justify-between text-[11px] text-muted">
          <span>0&apos;</span>
          <span>45&apos;</span>
          <span>90&apos;</span>
        </div>
      </div>
    </Card>
  );
}

export interface RecentRow {
  id: bigint;
  home: number;
  away: number;
  homeGoals: number;
  awayGoals: number;
  status: string;
  cfg: MatchConfig | null;
}

export function RecentResults({ rows }: { rows: RecentRow[] }) {
  return (
    <Card>
      <CardHeader
        title="Previous results"
        right={
          <Link href="/matches" className="text-[12px] text-muted hover:text-fg">
            All matches
          </Link>
        }
      />
      {rows.length === 0 ? (
        <Empty>No settled matches yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id.toString()}>
              <Link
                href={`/matches/${r.id}`}
                className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-raised"
              >
                <span className="num w-20 shrink-0 text-muted">#{r.id.toString()}</span>
                <span className="flex-1 truncate text-right">{r.cfg?.home.short}</span>
                <span className="num w-12 text-center font-semibold">
                  {r.status === "Settled" ? `${r.homeGoals}-${r.awayGoals}` : "–"}
                </span>
                <span className="flex-1 truncate">{r.cfg?.away.short}</span>
                <Badge tone={r.status === "Settled" ? "pos" : r.status === "Voided" ? "warn" : "muted"}>
                  {r.status}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const clockText = (seconds: number) => formatClock(seconds);
export type { MatchResult };
