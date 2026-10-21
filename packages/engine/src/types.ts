import type { TeamConfig } from "./teams";

export type Side = 0 | 1;
export type FirstScorer = "home" | "away" | "none";

export type EventType =
  | "kickoff"
  | "pass"
  | "cross"
  | "shot"
  | "save"
  | "block"
  | "goal"
  | "tackle"
  | "interception"
  | "clearance"
  | "foul"
  | "corner"
  | "free_kick"
  | "penalty"
  | "throw_in"
  | "goal_kick"
  | "halftime"
  | "fulltime";

export interface MatchEvent {
  /** 0-based, strictly increasing. */
  seq: number;
  /** Simulation tick (0.1 game seconds). */
  tick: number;
  type: EventType;
  /** 0 = home, 1 = away, -1 = neither. */
  team: -1 | 0 | 1;
  /** Global player index 0..21 (home 0..10, away 11..21), -1 = none. */
  player: number;
  /** Second player (receiver, assister, tackled player, goalkeeper), -1 = none. */
  other: number;
  /** Outcome flag: pass completed, shot on target, tackle won, etc. */
  ok: boolean;
  x: number;
  y: number;
  /** Score after this event. */
  home: number;
  away: number;
}

export interface TeamStats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  corners: number;
  fouls: number;
  saves: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  interceptions: number;
  possession: number;
}

export interface MatchConfig {
  version: string;
  matchId: string;
  home: TeamConfig;
  away: TeamConfig;
}

export interface MatchResult {
  config: MatchConfig;
  seed: string;
  homeGoals: number;
  awayGoals: number;
  firstScorer: FirstScorer;
  stats: [TeamStats, TeamStats];
  possessionTicks: [number, number];
  events: MatchEvent[];
  /** FRAME_COUNT × FRAME_STRIDE positions in decimetres. */
  frames: Int16Array;
  /** Ball owner per frame, -1 = loose. */
  owners: Int8Array;
}
