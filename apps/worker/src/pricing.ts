import { buildConfig, keccakHex, simulate } from "@oddra/engine";
import { priceFromSamples, type Pricing, type SampleResult } from "@oddra/shared";

const firstCode = (f: "home" | "away" | "none") => (f === "none" ? 0 : f === "home" ? 1 : 2);

/**
 * Prices a fixture by simulating it `samples` times with pricing-only seeds (never the match's committed seed, which
 * the worker cannot know in advance anyway because the entropy does not exist yet), plus any past results between
 * the same clubs. Yields to the event loop between simulations so live broadcasting never stalls.
 */
export async function priceFixture(
  matchId: bigint,
  home: number,
  away: number,
  samples: number,
  history: SampleResult[] = [],
  margin = 0.06,
): Promise<Pricing> {
  const cfg = buildConfig(matchId, home, away);
  const results: SampleResult[] = [...history];
  for (let i = 0; i < samples; i++) {
    const r = simulate(cfg, keccakHex(`oddra-pricing|${home}|${away}|${i}`));
    results.push({ h: r.homeGoals, a: r.awayGoals, first: firstCode(r.firstScorer) });
    await new Promise((res) => setImmediate(res));
  }
  return priceFromSamples(results, { margin });
}
