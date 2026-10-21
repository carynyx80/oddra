import { BETTING_SECONDS, CYCLE_SECONDS, LIVE_SECONDS, TEAMS } from "@oddra/engine";

/**
 * Global 20-minute slots: slot n opens betting at n × 1200 s (Unix time), kicks off 300 s later and ends 1200 s after
 * opening, exactly when slot n+1 opens. The slot number is the on-chain match id, so every client can work out which
 * match is current from the time alone. 72 matches a day; never two live at once.
 */
export type Phase = "betting" | "live" | "finished" | "upcoming";

export interface Slot {
  matchId: bigint;
  openTime: number;
  kickoff: number;
  fullTime: number;
}

export function slotAt(unixSeconds: number): Slot {
  return slot(BigInt(Math.floor(unixSeconds / CYCLE_SECONDS)));
}

export function slot(matchId: bigint): Slot {
  const openTime = Number(matchId) * CYCLE_SECONDS;
  return {
    matchId,
    openTime,
    kickoff: openTime + BETTING_SECONDS,
    fullTime: openTime + BETTING_SECONDS + LIVE_SECONDS,
  };
}

export function phaseOf(s: Slot, now: number): Phase {
  if (now < s.openTime) return "upcoming";
  if (now < s.kickoff) return "betting";
  if (now < s.fullTime) return "live";
  return "finished";
}

/**
 * Fixture for a slot: a double round robin of the 20 clubs (circle method), 380 fixtures, repeating. Deterministic
 * and public, so nobody chooses pairings after seeing anything.
 */
export function fixtureFor(matchId: bigint): { home: number; away: number } {
  const n = TEAMS.length; // 20
  const perRound = n / 2;
  const total = (n - 1) * perRound * 2;
  const k = Number(matchId % BigInt(total));
  const leg = k >= total / 2 ? 1 : 0;
  const idx = k % (total / 2);
  const round = Math.floor(idx / perRound);
  const pair = idx % perRound;
  // circle method: team n-1 fixed, others rotate
  const rot = (i: number) => (i === n - 1 ? n - 1 : (i + round) % (n - 1));
  const a = rot(pair);
  const b = rot(n - 1 - pair);
  const flip = (round + pair) % 2 === 1;
  const [home, away] = flip ? [b, a] : [a, b];
  return leg === 0 ? { home, away } : { home: away, away: home };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
