import { create } from "zustand";

export interface SlipPick {
  matchId: bigint;
  selection: number;
  odds: number; // × 100, the price shown when picked
}

/** Single-selection bet slip (accumulators are out of scope for v1). */
export const useSlip = create<{
  pick: SlipPick | null;
  stake: string;
  setPick: (p: SlipPick | null) => void;
  setStake: (s: string) => void;
}>((set) => ({
  pick: null,
  stake: "10",
  setPick: (pick) => set({ pick }),
  setStake: (stake) => set({ stake }),
}));
