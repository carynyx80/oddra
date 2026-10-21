import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ENGINE_VERSION } from "./constants";
import { Simulation } from "./sim";
import { team } from "./teams";
import type { MatchConfig, MatchResult } from "./types";

export * from "./constants";
export * from "./formations";
export * from "./rng";
export * from "./teams";
export * from "./types";
export { Simulation, deriveStats } from "./sim";

/** The full, committed input of a match, rebuilt from on-chain data (match id and team ids) plus this ruleset. */
export function buildConfig(matchId: bigint | string, homeTeamId: number, awayTeamId: number): MatchConfig {
  if (homeTeamId === awayTeamId) throw new Error("a team cannot play itself");
  return {
    version: ENGINE_VERSION,
    matchId: BigInt(matchId).toString(),
    home: team(homeTeamId),
    away: team(awayTeamId),
  };
}

/** Deterministic JSON: object keys sorted, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const keccakHex = (data: Uint8Array | string): `0x${string}` =>
  `0x${bytesToHex(keccak_256(typeof data === "string" ? utf8ToBytes(data) : data))}`;

/** keccak256 of the canonical config. Committed on-chain before betting opens. */
export const configHash = (c: MatchConfig) => keccakHex(canonicalJson(c));

/**
 * The final seed: keccak256(abi.encodePacked(serverSeed, entropy, matchId)), computed identically by the registry
 * contract. serverSeed is committed before betting; entropy is an L2 block hash that does not exist until betting closes.
 */
export function finalSeed(serverSeed: `0x${string}`, entropy: `0x${string}`, matchId: bigint): `0x${string}` {
  const buf = new Uint8Array(96);
  buf.set(hexBytes(serverSeed), 0);
  buf.set(hexBytes(entropy), 32);
  let m = matchId;
  for (let i = 95; i >= 64; i--) {
    buf[i] = Number(m & 0xffn);
    m >>= 8n;
  }
  return keccakHex(buf);
}

function hexBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length !== 64) throw new Error("expected 32 bytes");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function simulate(config: MatchConfig, seed: string): MatchResult {
  return new Simulation(config, seed).run();
}

export const eventLogHash = (r: MatchResult) => keccakHex(canonicalJson(r.events));
export const framesHash = (r: MatchResult) =>
  keccakHex(new Uint8Array(r.frames.buffer, r.frames.byteOffset, r.frames.byteLength));

/**
 * The result hash posted on-chain at settlement. It binds the score, first scorer, statistics, every event and every
 * recorded position, so the animation, the stats and the settled result are provably the same simulation.
 */
export function resultHash(r: MatchResult): `0x${string}` {
  return keccakHex(
    canonicalJson({
      version: r.config.version,
      configHash: configHash(r.config),
      seed: r.seed,
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
      firstScorer: r.firstScorer,
      stats: r.stats,
      eventLogHash: eventLogHash(r),
      framesHash: framesHash(r),
    }),
  );
}

/** First scorer as stored on-chain: 0 none, 1 home, 2 away. */
export const firstScorerCode = (f: MatchResult["firstScorer"]) => (f === "none" ? 0 : f === "home" ? 1 : 2);
