import { create } from "zustand";
import type { AssetKey } from "@oddra/shared";

export interface SlipPick {
  matchId: bigint;
  selection: number;
  odds: number; // × 100, the price shown when picked
  /** exchange mode: back (bet for) or lay (bet against) the selection */
  side?: "back" | "lay";
}

/** Single-selection bet slip (accumulators are out of scope for v1). */
export const useSlip = create<{
  pick: SlipPick | null;
  stake: string;
  /** exchange mode: the asset whose order book is shown and traded */
  asset: AssetKey;
  setPick: (p: SlipPick | null) => void;
  setStake: (s: string) => void;
  setAsset: (a: AssetKey) => void;
}>((set) => ({
  pick: null,
  stake: "10",
  asset: "USDG",
  setPick: (pick) => set({ pick }),
  setStake: (stake) => set({ stake }),
  setAsset: (asset) => set({ asset }),
}));
