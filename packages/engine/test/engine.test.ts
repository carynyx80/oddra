import { describe, expect, it } from "vitest";
import {
  FORMATIONS,
  FRAME_COUNT,
  FRAME_STRIDE,
  PITCH,
  TEAMS,
  TOTAL_TICKS,
  buildConfig,
  configHash,
  deriveStats,
  eventLogHash,
  finalSeed,
  isLegalFormation,
  keccakHex,
  resultHash,
  simulate,
  type MatchResult,
} from "../src/index";

const SEED = keccakHex("oddra-test-seed");
const cache = new Map<string, MatchResult>();
function run(home = 0, away = 7, seed = SEED, id = 1n): MatchResult {
  const key = `${home}-${away}-${seed}-${id}`;
  if (!cache.has(key)) cache.set(key, simulate(buildConfig(id, home, away), seed));
  return cache.get(key)!;
}

describe("determinism", () => {
  it("identical inputs give identical results, events and frames", () => {
    const a = simulate(buildConfig(1n, 0, 7), SEED);
    const b = simulate(buildConfig(1n, 0, 7), SEED);
    expect(resultHash(a)).toBe(resultHash(b));
    expect(eventLogHash(a)).toBe(eventLogHash(b));
    expect(Buffer.from(a.frames.buffer).equals(Buffer.from(b.frames.buffer))).toBe(true);
  });

  it("a different seed gives a different match", () => {
    const other = run(0, 7, keccakHex("another seed"));
    expect(resultHash(other)).not.toBe(resultHash(run()));
  });

  it("the config hash depends on the match id and both teams", () => {
    const base = configHash(buildConfig(1n, 0, 7));
    expect(configHash(buildConfig(2n, 0, 7))).not.toBe(base);
    expect(configHash(buildConfig(1n, 7, 0))).not.toBe(base);
    expect(configHash(buildConfig(1n, 0, 7))).toBe(base);
  });

  it("finalSeed matches keccak256(abi.encodePacked(bytes32, bytes32, uint256))", () => {
    // reference: cast keccak $(cast concat-hex 0x11…11 0x22…22 $(cast to-uint256 7))
    const s = finalSeed(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, 7n);
    expect(s).toBe("0xda8fad87e0e80b2a447c1d961402de154af44a4dd6114eaea21775ce81b9b7b7");
  });

  it("rejects a team playing itself", () => {
    expect(() => buildConfig(1n, 3, 3)).toThrow();
  });
});

describe("teams and formations", () => {
  it("every team is legal and every supported formation is legal", () => {
    expect(TEAMS).toHaveLength(20);
    for (const f of Object.values(FORMATIONS)) expect(isLegalFormation(f)).toBe(true);
    for (const t of TEAMS) {
      expect(t.players).toHaveLength(11);
      expect(t.players.filter((p) => p.role === "GK")).toHaveLength(1);
      for (const p of t.players)
        for (const v of Object.values(p.attrs)) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(99);
        }
    }
  });

  it("all four formations are used in the league", () => {
    expect(new Set(TEAMS.map((t) => t.formation))).toEqual(new Set(["4-3-3", "4-4-2", "4-2-3-1", "3-5-2"]));
  });
});

describe("a full match", () => {
  it("runs exactly 90 minutes and ends with a single final whistle", () => {
    const r = run();
    const last = r.events[r.events.length - 1];
    expect(last.type).toBe("fulltime");
    expect(last.tick).toBe(TOTAL_TICKS);
    expect(r.events.filter((e) => e.type === "fulltime")).toHaveLength(1);
    expect(r.events.filter((e) => e.type === "halftime")).toHaveLength(1);
    expect(r.events.filter((e) => e.type === "kickoff").length).toBeGreaterThanOrEqual(2);
  });

  it("event sequence numbers and ticks never go backwards", () => {
    const r = run();
    r.events.forEach((e, i) => {
      expect(e.seq).toBe(i);
      if (i > 0) expect(e.tick).toBeGreaterThanOrEqual(r.events[i - 1].tick);
    });
  });

  it("the score equals the goal events, and the first scorer matches the first goal", () => {
    for (const seed of ["a", "b", "c", "d"].map((s) => keccakHex(s))) {
      const r = run(2, 9, seed);
      const goals = r.events.filter((e) => e.type === "goal");
      expect(goals.filter((g) => g.team === 0)).toHaveLength(r.homeGoals);
      expect(goals.filter((g) => g.team === 1)).toHaveLength(r.awayGoals);
      const first = goals[0];
      expect(r.firstScorer).toBe(!first ? "none" : first.team === 0 ? "home" : "away");
      const last = r.events[r.events.length - 1];
      expect([last.home, last.away]).toEqual([r.homeGoals, r.awayGoals]);
    }
  });

  it("statistics are exactly the counts of simulated events", () => {
    const r = run();
    expect(deriveStats(r.events, r.possessionTicks)).toEqual(r.stats);
    expect(r.stats[0].possession + r.stats[1].possession).toBeCloseTo(100, 5);
    const shots = r.events.filter((e) => e.type === "shot" && e.team === 0);
    expect(r.stats[0].shots).toBe(shots.length);
    expect(r.stats[0].shotsOnTarget).toBe(shots.filter((s) => s.ok).length);
    expect(r.stats[0].passesCompleted).toBeLessThanOrEqual(r.stats[0].passes);
  });

  it("records every frame and keeps players and ball near the pitch", () => {
    const r = run();
    expect(r.frames.length).toBe(FRAME_COUNT * FRAME_STRIDE);
    for (let f = 0; f < FRAME_COUNT; f += 7) {
      const o = f * FRAME_STRIDE;
      for (let k = 0; k < 22; k++) {
        const x = r.frames[o + k * 2] / 10;
        const y = r.frames[o + k * 2 + 1] / 10;
        expect(x).toBeGreaterThanOrEqual(-2.5);
        expect(x).toBeLessThanOrEqual(PITCH.L + 2.5);
        expect(y).toBeGreaterThanOrEqual(-2.5);
        expect(y).toBeLessThanOrEqual(PITCH.W + 2.5);
      }
      expect(r.frames[o + 46]).toBeGreaterThanOrEqual(0);
    }
  });

  it("players actually move and the ball changes hands", () => {
    const r = run();
    let moved = 0;
    for (let k = 0; k < 22; k++) {
      const a = r.frames[100 * FRAME_STRIDE + k * 2];
      const b = r.frames[400 * FRAME_STRIDE + k * 2];
      if (a !== b) moved++;
    }
    expect(moved).toBeGreaterThan(18);
    const owners = new Set(Array.from(r.owners));
    expect(owners.size).toBeGreaterThan(15);
    expect(owners.has(0) || owners.has(11)).toBe(true); // keepers handle the ball
  });

  it("produces the full range of football events", () => {
    const types = new Set<string>();
    for (const seed of ["e1", "e2", "e3", "e4", "e5", "e6"])
      for (const e of run(4, 13, keccakHex(seed)).events) types.add(e.type);
    for (const t of [
      "pass",
      "shot",
      "save",
      "tackle",
      "interception",
      "foul",
      "corner",
      "free_kick",
      "throw_in",
      "goal_kick",
      "kickoff",
    ])
      expect(types).toContain(t);
  });

  it("passes are completed far more often than not, and possession is shared", () => {
    const r = run();
    for (const s of r.stats) {
      expect(s.passesCompleted / s.passes).toBeGreaterThan(0.6);
      expect(s.possession).toBeGreaterThan(25);
    }
  });
});

describe("league-level realism", () => {
  it("averages realistic goals and shots over many matches, and stronger teams win more", () => {
    let goals = 0;
    let shots = 0;
    let strongWins = 0;
    let weakWins = 0;
    const n = 24;
    for (let i = 0; i < n; i++) {
      const r = simulate(buildConfig(BigInt(i), 0, 19), keccakHex(`league-${i}`));
      goals += r.homeGoals + r.awayGoals;
      shots += r.stats[0].shots + r.stats[1].shots;
      if (r.homeGoals > r.awayGoals) strongWins++;
      if (r.homeGoals < r.awayGoals) weakWins++;
    }
    expect(goals / n).toBeGreaterThan(1.2);
    expect(goals / n).toBeLessThan(5);
    expect(shots / n).toBeGreaterThan(10);
    expect(shots / n).toBeLessThan(40);
    expect(strongWins).toBeGreaterThan(weakWins);
  });
});
