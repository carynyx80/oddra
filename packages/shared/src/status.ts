/** OddraMatchRegistry.Status, in contract order. */
export const MATCH_STATUS = [
  "None",
  "Scheduled",
  "Locked",
  "Revealed",
  "Proposed",
  "Disputed",
  "Settled",
  "Voided",
] as const;
export type MatchStatusName = (typeof MATCH_STATUS)[number];

export const ST = {
  None: 0,
  Scheduled: 1,
  Locked: 2,
  Revealed: 3,
  Proposed: 4,
  Disputed: 5,
  Settled: 6,
  Voided: 7,
} as const;

/** The final seed is public: the match can be replayed. */
export const isRevealed = (s: number) => s >= ST.Revealed && s <= ST.Settled;
/** A result exists on-chain (proposed, disputed or final). */
export const hasResult = (s: number) => s >= ST.Proposed && s <= ST.Settled;
