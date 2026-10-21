import { CS_OTHER, SELECTION_COUNT, csSelection, winMask } from "./markets";

/**
 * Fixed-odds pricing.
 *
 * 1. Fair probabilities come from simulating the fixture many times with the real engine (independent seeds, never
 *    the match's own), optionally blended with the stored results of past simulated matches between the same clubs.
 * 2. Rare outcomes are smoothed toward an independent-Poisson model fitted to the simulated goal means.
 * 3. A per-market overround (house margin) is applied, and prices are rounded down to two decimals.
 * 4. During the betting window, selections carrying heavy liability are shortened (exposure skew). Accepted bets keep
 *    their price on-chain; only new bets see the new one.
 */
export interface SampleResult {
  h: number;
  a: number;
  first: number; // 0 none, 1 home, 2 away
}

export interface PricingOptions {
  /** Overround per market, e.g. 0.06 = 106% book. Correct score carries more. */
  margin?: number;
  correctScoreMargin?: number;
  /** Pseudo-count weight of the Poisson prior. */
  priorWeight?: number;
}

export interface Pricing {
  probabilities: number[];
  odds: number[]; // decimal × 100, as stored on-chain
  lambdaHome: number;
  lambdaAway: number;
  samples: number;
}

const MIN = 101;
const MAX = 100_000;
/** Offered prices stay within 1.05–250.00; simulated probabilities below 0.4% are too noisy to price longer. */
const MIN_OFFERED = 105;
const MAX_OFFERED = 25_000;

function poisson(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/** Probability of each selection under independent Poisson goals, first scorer by share of goal rate. */
export function poissonProbabilities(lh: number, la: number): number[] {
  const p = new Array<number>(SELECTION_COUNT).fill(0);
  const shareH = lh + la > 0 ? lh / (lh + la) : 0.5;
  for (let h = 0; h <= 12; h++) {
    for (let a = 0; a <= 12; a++) {
      const pr = poisson(lh, h) * poisson(la, a);
      if (pr < 1e-12) continue;
      const firsts: [number, number][] =
        h + a === 0
          ? [[0, 1]]
          : h === 0
            ? [[2, 1]]
            : a === 0
              ? [[1, 1]]
              : [
                  [1, shareH],
                  [2, 1 - shareH],
                ];
      for (const [f, w] of firsts) {
        const m = winMask(h, a, f);
        for (let s = 0; s < SELECTION_COUNT; s++) if ((m >>> s) & 1) p[s] += pr * w;
      }
    }
  }
  return p;
}

const GROUPS: number[][] = [
  [0, 1, 2],
  [6, 7],
  [8, 9],
  [10, 11, 12],
  [...Array.from({ length: 16 }, (_, k) => 13 + k), CS_OTHER],
];

export function priceFromSamples(samples: SampleResult[], opts: PricingOptions = {}): Pricing {
  const margin = opts.margin ?? 0.06;
  const csMargin = opts.correctScoreMargin ?? 0.2;
  const w = opts.priorWeight ?? 20;
  const n = samples.length;
  if (n === 0) throw new Error("no samples");
  let gh = 0;
  let ga = 0;
  const counts = new Array<number>(SELECTION_COUNT).fill(0);
  for (const r of samples) {
    gh += r.h;
    ga += r.a;
    const m = winMask(r.h, r.a, r.first);
    for (let s = 0; s < SELECTION_COUNT; s++) if ((m >>> s) & 1) counts[s]++;
  }
  const lambdaHome = Math.max(0.05, gh / n);
  const lambdaAway = Math.max(0.05, ga / n);
  const prior = poissonProbabilities(lambdaHome, lambdaAway);
  const prob = counts.map((c, s) => (c + w * prior[s]) / (n + w));

  // normalise each exclusive group to exactly 1, then derive double chance from the result market
  for (const g of GROUPS) {
    const sum = g.reduce((t, s) => t + prob[s], 0);
    for (const s of g) prob[s] /= sum;
  }
  prob[3] = prob[0] + prob[1];
  prob[4] = prob[0] + prob[2];
  prob[5] = prob[1] + prob[2];

  const odds = prob.map((p, s) => {
    const m = s >= 13 ? csMargin : margin;
    // margin on double chance is applied on its own pair-sum basis
    const fair = 1 / Math.max(p, 1e-6);
    const priced = Math.floor((fair / (1 + m)) * 100);
    // near-certainties cannot carry a margin: suspend them rather than offer a price with no edge
    if (priced < MIN_OFFERED) return 0;
    return Math.min(MAX_OFFERED, priced);
  });
  return { probabilities: prob, odds, lambdaHome, lambdaAway, samples: n };
}

export const clampOdds = (x100: number) => Math.min(MAX, Math.max(MIN, Math.round(x100)));

/**
 * Exposure skew: shorten a selection's price as its potential payout grows relative to the free treasury balance.
 * `liability[s]` and `free` share one unit (USDG base units). At most `maxCut` (default 20%) off the base price.
 */
export function skewForExposure(base: number[], liability: readonly bigint[], free: bigint, maxCut = 0.2): number[] {
  if (free <= 0n) return base.map(() => 0);
  return base.map((o, s) => {
    if (o === 0) return 0;
    const share = Number(((liability[s] ?? 0n) * 10_000n) / free) / 10_000;
    const cut = Math.min(maxCut, share * 2);
    return clampOdds(Math.floor(o * (1 - cut)));
  });
}

/** Implied book percentage of an exclusive group (suspended selections count as certain), for display and tests. */
export const overround = (odds: number[], group: number[]) =>
  group.reduce((t, s) => t + (odds[s] > 0 ? 10_000 / odds[s] : 100), 0);

export { csSelection };
