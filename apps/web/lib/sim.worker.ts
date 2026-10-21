/// <reference lib="webworker" />
import { buildConfig, simulate } from "@oddra/engine";

// Runs the deterministic engine off the main thread (~150 ms for a full 90 minutes).
self.onmessage = (e: MessageEvent<{ id: string; home: number; away: number; seed: string }>) => {
  try {
    const { id, home, away, seed } = e.data;
    const result = simulate(buildConfig(BigInt(id), home, away), seed);
    (self as unknown as Worker).postMessage({ ok: true, result }, [result.frames.buffer, result.owners.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
