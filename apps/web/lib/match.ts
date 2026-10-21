import {
  DT,
  FRAME_EVERY,
  FRAME_STRIDE,
  Simulation,
  buildConfig,
  deriveStats,
  type MatchConfig,
  type MatchEvent,
  type MatchResult,
  type TeamStats,
} from "@oddra/engine";

const ZERO_SEED = `0x${"00".repeat(32)}`;
const previews = new Map<string, Int16Array>();
const configs = new Map<string, MatchConfig>();

export function configFor(id: bigint, home: number, away: number): MatchConfig | null {
  if (home === away) return null;
  const k = `${id}-${home}-${away}`;
  let c = configs.get(k);
  if (!c) {
    c = buildConfig(id, home, away);
    configs.set(k, c);
  }
  return c;
}

/** Kickoff shape: frame 0 does not depend on the seed, so it can be shown before the reveal. */
export function previewFrame(cfg: MatchConfig): Int16Array {
  const k = `${cfg.matchId}-${cfg.home.id}-${cfg.away.id}`;
  let p = previews.get(k);
  if (!p) {
    p = new Simulation(cfg, ZERO_SEED).frames.slice(0, FRAME_STRIDE);
    previews.set(k, p);
  }
  return p;
}

/** Statistics as of `gameSeconds`, counted from the events and frames shown so far. */
export function statsAt(r: MatchResult, gameSeconds: number): [TeamStats, TeamStats] {
  const tick = gameSeconds / DT;
  const events = r.events.filter((e) => e.tick <= tick);
  const lastFrame = Math.min(r.owners.length - 1, Math.floor(tick / FRAME_EVERY));
  const poss: [number, number] = [0, 0];
  let last = -1;
  for (let f = 0; f <= lastFrame; f++) {
    const o = r.owners[f];
    if (o >= 0) last = o < 11 ? 0 : 1;
    if (last >= 0) poss[last as 0 | 1]++;
  }
  return deriveStats(events, poss);
}

export const KEY_EVENTS = new Set<MatchEvent["type"]>([
  "goal",
  "shot",
  "save",
  "corner",
  "foul",
  "penalty",
  "free_kick",
  "halftime",
  "fulltime",
  "kickoff",
]);
export const minuteOf = (tick: number) => Math.min(90, Math.floor(tick / 600) + 1);
