"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import {
  FRAME_EVERY,
  FRAME_STRIDE,
  DT,
  PITCH,
  type MatchConfig,
  type MatchEvent,
  type MatchResult,
  type TeamStats,
} from "@oddra/engine";
import { commentary } from "@oddra/shared";
import { kits } from "@/components/Pitch";
import { Commentary } from "@/components/live/Commentary";
import { Crest } from "@/components/live/Scoreboard";
import { Empty, Tabs } from "@/components/ui/primitives";
import { minuteOf } from "@/lib/match";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ momentum

const BUCKET = 180; // game seconds per bar (3 minutes)

/**
 * Attacking momentum per 3-minute window: time each side keeps the ball within 35 m of the opponent's goal, plus
 * shots and goals. Positive = home pressure, negative = away. Computed from the same frames and events everyone sees.
 */
export function momentum(r: MatchResult, upTo: number): number[] {
  const out: number[] = [];
  const buckets = Math.ceil(5400 / BUCKET);
  const lastFrame = Math.floor(upTo / (DT * FRAME_EVERY));
  for (let b = 0; b < buckets; b++) {
    const f0 = Math.floor((b * BUCKET) / (DT * FRAME_EVERY));
    if (f0 > lastFrame) break;
    const f1 = Math.min(lastFrame, Math.floor(((b + 1) * BUCKET) / (DT * FRAME_EVERY)) - 1);
    let home = 0;
    let away = 0;
    for (let f = f0; f <= f1; f++) {
      const o = r.owners[f];
      if (o < 0) continue;
      const team = o < 11 ? 0 : 1;
      const firstHalf = f * FRAME_EVERY < 27_000;
      const attacksRight = (team === 0) === firstHalf;
      const bx = r.frames[f * FRAME_STRIDE + 44] / 10;
      const dist = attacksRight ? PITCH.L - bx : bx;
      if (dist < 35) {
        if (team === 0) home++;
        else away++;
      }
    }
    for (const e of r.events) {
      if (e.tick * DT < b * BUCKET || e.tick * DT >= Math.min(upTo, (b + 1) * BUCKET)) continue;
      const w = e.type === "goal" ? 30 : e.type === "shot" ? (e.ok ? 14 : 8) : e.type === "corner" ? 5 : 0;
      if (e.team === 0) home += w;
      else if (e.team === 1) away += w;
    }
    out.push(home - away);
  }
  return out;
}

export function Momentum({
  cfg,
  result,
  gameSeconds,
}: {
  cfg: MatchConfig;
  result: MatchResult | null;
  gameSeconds: number;
}) {
  const bucket = Math.floor(gameSeconds / 30);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bars = useMemo(() => (result ? momentum(result, gameSeconds) : []), [result, bucket]);
  const [hk, ak] = kits(cfg);
  const max = Math.max(20, ...bars.map(Math.abs));
  const n = Math.ceil(5400 / BUCKET);
  const goals = result ? result.events.filter((e) => e.type === "goal" && e.tick * DT <= gameSeconds) : [];
  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>{cfg.home.short} pressure</span>
        <span>Momentum</span>
        <span>{cfg.away.short} pressure</span>
      </div>
      <div className="relative h-14">
        <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-line/70" />
        <div className="absolute inset-0 flex items-stretch gap-[2px]">
          {Array.from({ length: n }, (_, i) => {
            const v = bars[i] ?? 0;
            const h = (Math.abs(v) / max) * 50;
            return (
              <div key={i} className="relative flex-1">
                {i < bars.length ? (
                  <div
                    className="absolute left-0 right-0 rounded-[1px] transition-all duration-500"
                    style={
                      v >= 0
                        ? { bottom: "50%", height: `${h}%`, background: hk }
                        : { top: "50%", height: `${h}%`, background: ak }
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        {goals.map((g) => (
          <div
            key={g.seq}
            className="absolute -translate-x-1/2"
            style={{ left: `${((g.tick * DT) / 5400) * 100}%`, ...(g.team === 0 ? { top: -4 } : { bottom: -4 }) }}
            title={commentary(cfg, g) ?? "Goal"}
          >
            <span className="block h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" />
          </div>
        ))}
      </div>
      <div className="num mt-1 flex justify-between text-[10px] text-muted">
        <span>0&apos;</span>
        <span>45&apos;</span>
        <span>90&apos;</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ possession

export function PossessionBar({ cfg, stats }: { cfg: MatchConfig; stats: [TeamStats, TeamStats] | null }) {
  const [hk, ak] = kits(cfg);
  const h = stats ? Math.round(stats[0].possession) : 50;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
      <span className="num w-10 font-semibold">{stats ? `${h}%` : "–"}</span>
      <div className="flex h-1.5 flex-1 gap-0.5 overflow-hidden rounded-full">
        <div className="transition-all duration-700" style={{ width: `${h}%`, background: hk }} />
        <div className="flex-1 transition-all duration-700" style={{ background: ak }} />
      </div>
      <span className="num w-10 text-right font-semibold">{stats ? `${100 - h}%` : "–"}</span>
      <span className="label hidden sm:inline">Possession</span>
    </div>
  );
}

// ------------------------------------------------------------------ stats

const ROWS: { key: keyof TeamStats; label: string }[] = [
  { key: "shots", label: "Shots" },
  { key: "shotsOnTarget", label: "On target" },
  { key: "saves", label: "Saves" },
  { key: "corners", label: "Corners" },
  { key: "fouls", label: "Fouls" },
  { key: "passes", label: "Passes" },
  { key: "tackles", label: "Tackles won" },
  { key: "interceptions", label: "Interceptions" },
];

export function StatsBars({ cfg, stats }: { cfg: MatchConfig; stats: [TeamStats, TeamStats] | null }) {
  const [hk, ak] = kits(cfg);
  if (!stats) return <Empty>Statistics appear once the match kicks off.</Empty>;
  const acc = (s: TeamStats) => (s.passes ? `${Math.round((s.passesCompleted / s.passes) * 100)}%` : "–");
  return (
    <div className="grid gap-x-8 gap-y-3 p-4 sm:grid-cols-2">
      {ROWS.map((r) => {
        const a = stats[0][r.key] as number;
        const b = stats[1][r.key] as number;
        const total = a + b || 1;
        return (
          <div key={r.key}>
            <div className="num mb-1 flex justify-between text-[12px]">
              <span className={cn("font-semibold", a > b && "text-fg", a < b && "text-muted")}>{a}</span>
              <span className="text-muted">
                {r.label}
                {r.key === "passes" ? ` · ${acc(stats[0])} / ${acc(stats[1])}` : ""}
              </span>
              <span className={cn("font-semibold", b > a && "text-fg", b < a && "text-muted")}>{b}</span>
            </div>
            <div className="flex h-1 gap-0.5 overflow-hidden rounded">
              <div className="transition-all duration-500" style={{ width: `${(a / total) * 100}%`, background: hk }} />
              <div className="flex-1 transition-all duration-500" style={{ background: ak }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ timeline

const ICON: Partial<Record<MatchEvent["type"], string>> = {
  goal: "⚽",
  penalty: "P",
  save: "S",
  corner: "C",
  foul: "F",
};

export function TimelineList({ cfg, events }: { cfg: MatchConfig; events: MatchEvent[] }) {
  const key = events.filter(
    (e) =>
      e.type === "goal" ||
      e.type === "penalty" ||
      e.type === "halftime" ||
      e.type === "fulltime" ||
      (e.type === "shot" && e.ok),
  );
  if (key.length === 0) return <Empty>Key moments appear here as they happen.</Empty>;
  return (
    <ol className="relative mx-4 my-3 border-l border-line">
      {[...key].reverse().map((e) => {
        const team = e.team === 0 ? cfg.home : e.team === 1 ? cfg.away : null;
        const isGoal = e.type === "goal";
        return (
          <li key={e.seq} className="relative py-2 pl-5">
            <span
              className={cn(
                "absolute -left-[5px] top-3.5 h-2.5 w-2.5 rounded-full border-2 border-bg",
                isGoal ? "bg-accent" : e.team === -1 ? "bg-muted" : "bg-raised",
              )}
            />
            <div className="flex items-center gap-2 text-[13px]">
              <span className="num w-8 text-muted">
                {e.type === "halftime" ? "HT" : e.type === "fulltime" ? "FT" : `${minuteOf(e.tick)}'`}
              </span>
              {team ? <Crest team={team} kit={kits(cfg)[e.team as 0 | 1]} size={18} /> : null}
              <span className={isGoal ? "font-medium" : "text-[#d4d4da]"}>{commentary(cfg, e) ?? e.type}</span>
              {ICON[e.type] && isGoal ? (
                <span className="num ml-auto font-semibold">
                  {e.home}-{e.away}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ line-ups

const ROLE_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 } as const;

export function Lineups({ cfg, result }: { cfg: MatchConfig; result: MatchResult | null }) {
  const [hk, ak] = kits(cfg);
  const goals = new Map<number, number>();
  for (const e of result?.events ?? [])
    if (e.type === "goal" && e.player >= 0) goals.set(e.player, (goals.get(e.player) ?? 0) + 1);
  const col = (side: 0 | 1) => {
    const t = side === 0 ? cfg.home : cfg.away;
    const kit = side === 0 ? hk : ak;
    return (
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <Crest team={t} kit={kit} size={20} />
          <span className="truncate text-[13px] font-medium">{t.name}</span>
          <span className="num ml-auto text-[11px] text-muted">{t.formation}</span>
        </div>
        <ul className="space-y-1">
          {t.players
            .map((p, i) => ({ p, i }))
            .sort((a, b) => ROLE_ORDER[a.p.role] - ROLE_ORDER[b.p.role])
            .map(({ p, i }) => {
              const best = Math.max(p.attrs.finishing, p.attrs.passing, p.attrs.tackling, p.attrs.goalkeeping);
              return (
                <li key={i} className="flex items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-raised">
                  <span
                    className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ background: kit, color: "#050505" }}
                  >
                    {p.number}
                  </span>
                  <span className="truncate">{p.name}</span>
                  {goals.get(side * 11 + i) ? (
                    <span className="text-[11px]">{"⚽".repeat(goals.get(side * 11 + i)!)}</span>
                  ) : null}
                  <span className="ml-auto text-[10px] text-muted">{p.role}</span>
                  <span className="num w-6 text-right text-[11px] text-muted">{best}</span>
                </li>
              );
            })}
        </ul>
      </div>
    );
  };
  return (
    <div className="grid gap-6 p-4 sm:grid-cols-2">
      {col(0)}
      {col(1)}
    </div>
  );
}

// ------------------------------------------------------------------ tabs

type TabKey = "commentary" | "stats" | "timeline" | "lineups";

export function MatchTabs({
  cfg,
  events,
  stats,
  result,
  liveBadge,
}: {
  cfg: MatchConfig;
  events: MatchEvent[];
  stats: [TeamStats, TeamStats] | null;
  result: MatchResult | null;
  liveBadge?: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("commentary");
  return (
    <div>
      <div className="flex items-center justify-between pr-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "commentary", label: "Commentary" },
            { key: "stats", label: "Stats" },
            { key: "timeline", label: "Key moments" },
            { key: "lineups", label: "Line-ups" },
          ]}
        />
        {liveBadge}
      </div>
      <div className="min-h-56">
        {tab === "commentary" ? <Commentary cfg={cfg} events={events} max={60} /> : null}
        {tab === "stats" ? <StatsBars cfg={cfg} stats={stats} /> : null}
        {tab === "timeline" ? <TimelineList cfg={cfg} events={events} /> : null}
        {tab === "lineups" ? <Lineups cfg={cfg} result={result} /> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ event toast over the pitch

const TOAST: Partial<Record<MatchEvent["type"], string>> = {
  goal: "GOAL",
  save: "SAVE",
  shot: "SHOT",
  penalty: "PENALTY",
  corner: "CORNER",
  free_kick: "FREE KICK",
  halftime: "HALF-TIME",
  fulltime: "FULL-TIME",
};

export function EventToast({
  cfg,
  events,
  gameSeconds,
}: {
  cfg: MatchConfig;
  events: MatchEvent[];
  gameSeconds: number;
}) {
  let e: MatchEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const x = events[i];
    if (gameSeconds - x.tick * DT > (x.type === "goal" ? 30 : 14)) break;
    if (TOAST[x.type]) {
      e = x;
      break;
    }
  }
  const team = e && e.team >= 0 ? (e.team === 0 ? cfg.home : cfg.away) : null;
  const goal = e?.type === "goal";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
      <AnimatePresence>
        {e ? (
          <motion.div
            key={e.seq}
            initial={{ y: -16, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: goal ? [1, 1.08, 1] : 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ duration: 0.35 }}
            className={cn(
              "flex items-center gap-2.5 rounded-full border px-3.5 py-1.5 backdrop-blur",
              goal
                ? "border-accent/60 bg-black/85 shadow-[0_0_40px_rgba(184,255,101,0.25)]"
                : "border-line bg-black/70",
            )}
          >
            {team ? <Crest team={team} kit={kits(cfg)[e.team as 0 | 1]} size={18} /> : null}
            <span className={cn("text-[12px] font-bold tracking-[0.18em]", goal ? "text-accent" : "text-fg")}>
              {TOAST[e.type]}
            </span>
            <span className="num text-[12px] text-muted">{minuteOf(e.tick)}&apos;</span>
            {goal ? (
              <span className="num text-[12px] font-semibold">
                {e.home}-{e.away}
              </span>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ results strip

export interface StripRow {
  id: bigint;
  cfg: MatchConfig | null;
  homeGoals: number;
  awayGoals: number;
  status: string;
}

export function ResultsStrip({ rows }: { rows: StripRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Previous results">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="label">Previous results</h2>
        <Link href="/matches" className="text-[12px] text-muted hover:text-fg">
          All matches →
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {rows.map((r) =>
          r.cfg ? (
            <Link
              key={r.id.toString()}
              href={`/matches/${r.id}`}
              className="min-w-[210px] flex-1 rounded-lg border border-line bg-card p-3 transition-colors hover:border-[#3a3a42]"
            >
              <div className="num mb-2 flex justify-between text-[10px] uppercase tracking-wider text-muted">
                <span>#{r.id.toString()}</span>
                <span className={r.status === "Settled" ? "text-pos" : r.status === "Voided" ? "text-warn" : ""}>
                  {r.status === "Settled" ? "Verified" : r.status === "Proposed" ? "Final soon" : r.status}
                </span>
              </div>
              {[0, 1].map((side) => {
                const t = side === 0 ? r.cfg!.home : r.cfg!.away;
                const g = side === 0 ? r.homeGoals : r.awayGoals;
                const o = side === 0 ? r.awayGoals : r.homeGoals;
                return (
                  <div key={side} className="flex items-center gap-2 py-0.5 text-[13px]">
                    <Crest team={t} kit={kits(r.cfg!)[side as 0 | 1]} size={18} />
                    <span className={cn("flex-1 truncate", r.status === "Settled" && g < o && "text-muted")}>
                      {t.name}
                    </span>
                    <span className="num font-semibold">
                      {r.status === "Settled" || r.status === "Proposed" ? g : "–"}
                    </span>
                  </div>
                );
              })}
            </Link>
          ) : null,
        )}
      </div>
    </section>
  );
}
