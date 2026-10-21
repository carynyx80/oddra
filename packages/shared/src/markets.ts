/**
 * The six launch markets, mirrored exactly from contracts/src/OddraMarkets.sol. Selection ids are the on-chain ids.
 */
export type MarketKey = "result" | "doubleChance" | "totals" | "btts" | "firstScorer" | "correctScore";

export interface Selection {
  id: number;
  market: MarketKey;
  label: string;
  short: string;
}

export const MARKETS: { key: MarketKey; title: string }[] = [
  { key: "result", title: "Match result" },
  { key: "doubleChance", title: "Double chance" },
  { key: "totals", title: "Total goals" },
  { key: "btts", title: "Both teams to score" },
  { key: "firstScorer", title: "First team to score" },
  { key: "correctScore", title: "Correct score" },
];

export const CS_OTHER = 29;
export const SELECTION_COUNT = 30;
export const csSelection = (h: number, a: number) => 13 + h * 4 + a;

export const SELECTIONS: Selection[] = [
  { id: 0, market: "result", label: "Home", short: "1" },
  { id: 1, market: "result", label: "Draw", short: "X" },
  { id: 2, market: "result", label: "Away", short: "2" },
  { id: 3, market: "doubleChance", label: "Home or draw", short: "1X" },
  { id: 4, market: "doubleChance", label: "Home or away", short: "12" },
  { id: 5, market: "doubleChance", label: "Draw or away", short: "X2" },
  { id: 6, market: "totals", label: "Over 2.5", short: "O2.5" },
  { id: 7, market: "totals", label: "Under 2.5", short: "U2.5" },
  { id: 8, market: "btts", label: "Yes", short: "BTTS Y" },
  { id: 9, market: "btts", label: "No", short: "BTTS N" },
  { id: 10, market: "firstScorer", label: "Home", short: "1st H" },
  { id: 11, market: "firstScorer", label: "Away", short: "1st A" },
  { id: 12, market: "firstScorer", label: "No goal", short: "No goal" },
  ...Array.from({ length: 16 }, (_, k) => {
    const h = Math.floor(k / 4);
    const a = k % 4;
    return { id: 13 + k, market: "correctScore" as const, label: `${h}-${a}`, short: `${h}-${a}` };
  }),
  { id: CS_OTHER, market: "correctScore", label: "Any other", short: "Other" },
];

export type FirstScorerCode = 0 | 1 | 2; // none, home, away

export function isValidResult(h: number, a: number, first: number): boolean {
  if (first < 0 || first > 2) return false;
  if (h === 0 && a === 0) return first === 0;
  if (first === 0) return false;
  return first === 1 ? h > 0 : a > 0;
}

/** Bitmask of winning selections; identical to OddraMarkets.winMask. */
export function winMask(h: number, a: number, first: number): number {
  if (!isValidResult(h, a, first)) throw new Error("invalid result");
  let m: number;
  if (h > a) m = (1 << 0) | (1 << 3) | (1 << 4);
  else if (h === a) m = (1 << 1) | (1 << 3) | (1 << 5);
  else m = (1 << 2) | (1 << 4) | (1 << 5);
  m |= h + a > 2 ? 1 << 6 : 1 << 7;
  m |= h > 0 && a > 0 ? 1 << 8 : 1 << 9;
  m |= first === 1 ? 1 << 10 : first === 2 ? 1 << 11 : 1 << 12;
  m |= h <= 3 && a <= 3 ? 1 << csSelection(h, a) : 1 << CS_OTHER;
  return m >>> 0;
}

export const selectionWins = (mask: number, selection: number) => ((mask >>> selection) & 1) === 1;

export function selectionsWon(h: number, a: number, first: number): number[] {
  const m = winMask(h, a, first);
  return SELECTIONS.filter((s) => selectionWins(m, s.id)).map((s) => s.id);
}

export const formatOdds = (x100: number) => (x100 / 100).toFixed(2);
