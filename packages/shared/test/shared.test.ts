import { describe, expect, it } from "vitest";
import { TEAMS, buildConfig, keccakHex, simulate } from "@oddra/engine";
import {
  CS_OTHER,
  SELECTIONS,
  csSelection,
  fixtureFor,
  overround,
  phaseOf,
  poissonProbabilities,
  priceFromSamples,
  selectionsWon,
  skewForExposure,
  slot,
  slotAt,
  winMask,
} from "../src/index";

describe("markets mirror the contract", () => {
  it("matches the Solidity win masks used in contracts/test/Markets.t.sol", () => {
    const bit = (s: number) => 2 ** s;
    expect(winMask(2, 1, 1)).toBe(bit(0) + bit(3) + bit(4) + bit(6) + bit(8) + bit(10) + bit(13 + 9));
    expect(winMask(0, 0, 0)).toBe(bit(1) + bit(3) + bit(5) + bit(7) + bit(9) + bit(12) + bit(13));
    expect(winMask(1, 5, 1)).toBe(bit(2) + bit(4) + bit(5) + bit(6) + bit(8) + bit(10) + bit(29));
    expect(() => winMask(0, 0, 1)).toThrow();
  });

  it("has 30 selections with on-chain ids", () => {
    expect(SELECTIONS).toHaveLength(30);
    SELECTIONS.forEach((s, i) => expect(s.id).toBe(i));
    expect(csSelection(3, 3)).toBe(28);
    expect(selectionsWon(5, 0, 1)).toContain(CS_OTHER);
  });
});

describe("schedule", () => {
  it("slots are 20 minutes: 5 betting, 15 live, back to back", () => {
    const s = slotAt(1_800_000_123);
    expect(s.kickoff - s.openTime).toBe(300);
    expect(s.fullTime - s.kickoff).toBe(900);
    expect(slot(s.matchId + 1n).openTime).toBe(s.fullTime);
    expect(phaseOf(s, s.openTime)).toBe("betting");
    expect(phaseOf(s, s.kickoff)).toBe("live");
    expect(phaseOf(s, s.fullTime)).toBe("finished");
    expect(phaseOf(s, s.openTime - 1)).toBe("upcoming");
  });

  it("72 matches a day", () => {
    expect(slotAt(86_400 * 2).matchId - slotAt(86_400).matchId).toBe(72n);
  });

  it("the fixture list is a fair double round robin", () => {
    const games = new Map<number, number>();
    const homes = new Map<number, number>();
    const pairs = new Set<string>();
    for (let i = 0n; i < 380n; i++) {
      const { home, away } = fixtureFor(i);
      expect(home).not.toBe(away);
      pairs.add(`${home}-${away}`);
      games.set(home, (games.get(home) ?? 0) + 1);
      games.set(away, (games.get(away) ?? 0) + 1);
      homes.set(home, (homes.get(home) ?? 0) + 1);
    }
    expect(pairs.size).toBe(380);
    for (let t = 0; t < TEAMS.length; t++) {
      expect(games.get(t)).toBe(38);
      expect(homes.get(t)).toBe(19);
    }
  });
});

describe("odds", () => {
  it("Poisson probabilities sum to one per market", () => {
    const p = poissonProbabilities(1.5, 1.1);
    expect(p[0] + p[1] + p[2]).toBeCloseTo(1, 6);
    expect(p[6] + p[7]).toBeCloseTo(1, 6);
    expect(p[10] + p[11] + p[12]).toBeCloseTo(1, 6);
    let cs = 0;
    for (let s = 13; s <= 29; s++) cs += p[s];
    expect(cs).toBeCloseTo(1, 6);
  });

  it("prices engine samples with a house margin on every market", () => {
    const samples = Array.from({ length: 30 }, (_, i) => {
      const r = simulate(buildConfig(BigInt(i), 0, 19), keccakHex(`odds-${i}`));
      return { h: r.homeGoals, a: r.awayGoals, first: r.firstScorer === "none" ? 0 : r.firstScorer === "home" ? 1 : 2 };
    });
    const p = priceFromSamples(samples);
    expect(p.odds[0]).toBeLessThan(p.odds[2]); // the stronger home side is favourite
    expect(overround(p.odds, [0, 1, 2])).toBeGreaterThan(100);
    expect(overround(p.odds, [6, 7])).toBeGreaterThan(100);
    expect(overround(p.odds, [8, 9])).toBeGreaterThan(100);
    expect(overround(p.odds, [10, 11, 12])).toBeGreaterThan(100);
    for (const o of p.odds) {
      if (o === 0) continue; // suspended: too likely to price with a margin
      expect(o).toBeGreaterThanOrEqual(105);
      expect(o).toBeLessThanOrEqual(25_000);
    }
  });

  it("exposure skew shortens only heavily backed selections, by at most 20%", () => {
    const base = new Array(30).fill(300);
    const liab = new Array<bigint>(30).fill(0n);
    liab[0] = 50_000n;
    const out = skewForExposure(base, liab, 100_000n);
    expect(out[0]).toBe(240);
    expect(out[1]).toBe(300);
  });
});
