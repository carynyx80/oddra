/** Ruleset version. Bump whenever any rule, constant or team data changes: it is part of every committed config. */
export const ENGINE_VERSION = "oddra-sim/1.0.0";

/** Pitch in metres. x runs goal line to goal line, y touchline to touchline. */
export const PITCH = {
  L: 105,
  W: 68,
  cy: 34,
  goalHalfW: 3.66,
  goalH: 2.44,
  boxDepth: 16.5,
  boxHalfW: 20.16,
  sixDepth: 5.5,
  sixHalfW: 9.16,
  penSpot: 11,
  centreR: 9.15,
  cornerR: 1,
} as const;

/** Simulation step in game seconds. 54,000 steps = 90 minutes. */
export const DT = 0.1;
export const HALF_TICKS = 27_000;
export const TOTAL_TICKS = 54_000;

/** A frame (all positions) is recorded every FRAME_EVERY ticks = 0.5 game seconds. */
export const FRAME_EVERY = 5;
export const ENTITY_COUNT = 22;
/** Per frame: 22 players × (x, y) + ball (x, y, z), in decimetres. */
export const FRAME_STRIDE = ENTITY_COUNT * 2 + 3;
export const FRAME_COUNT = TOTAL_TICKS / FRAME_EVERY + 1;

/** Real-time schedule: 5 min betting, 15 min live. A 90-minute match plays at 6× speed. */
export const BETTING_SECONDS = 300;
export const LIVE_SECONDS = 900;
export const CYCLE_SECONDS = BETTING_SECONDS + LIVE_SECONDS;
export const GAME_SECONDS_PER_REAL_SECOND = (TOTAL_TICKS * DT) / LIVE_SECONDS;
