import { createHmac } from "node:crypto";
import { hexToBytes, keccak256, type Address, type Hex } from "viem";

/**
 * The server seed for a match, derived from one secret: HMAC-SHA256(secret, chain | registry | matchId).
 * Deterministic, so a restarted worker always reveals exactly what it committed, with nothing secret in the database.
 * Whoever holds SERVER_SEED_SECRET can predict unrevealed matches: keep it in a secrets manager, never in the repo.
 */
export function serverSeed(secret: Hex, chainId: number, registry: Address, matchId: bigint): Hex {
  const mac = createHmac("sha256", Buffer.from(hexToBytes(secret)));
  mac.update(`oddra-seed|${chainId}|${registry.toLowerCase()}|${matchId.toString()}`);
  return `0x${mac.digest("hex")}`;
}

/** keccak256(abi.encodePacked(bytes32 seed)), as checked by OddraMatchRegistry.reveal. */
export const seedCommit = (seed: Hex) => keccak256(seed);
