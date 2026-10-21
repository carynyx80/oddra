export type Role = "GK" | "DEF" | "MID" | "FWD";
export type FormationName = "4-3-3" | "4-4-2" | "4-2-3-1" | "3-5-2";

/** A slot in team-relative coordinates: rx 0 = own goal line, 1 = opponent goal line; ry 0..1 across the pitch. */
export interface Slot {
  role: Role;
  rx: number;
  ry: number;
  /** Wide players stretch the pitch in possession. */
  wide: boolean;
}

const s = (role: Role, rx: number, ry: number): Slot => ({ role, rx, ry, wide: ry < 0.22 || ry > 0.78 });

const BACK_FOUR = [s("DEF", 0.21, 0.13), s("DEF", 0.18, 0.37), s("DEF", 0.18, 0.63), s("DEF", 0.21, 0.87)];

export const FORMATIONS: Record<FormationName, Slot[]> = {
  "4-3-3": [
    s("GK", 0.025, 0.5),
    ...BACK_FOUR,
    s("MID", 0.37, 0.3),
    s("MID", 0.33, 0.5),
    s("MID", 0.37, 0.7),
    s("FWD", 0.55, 0.14),
    s("FWD", 0.58, 0.5),
    s("FWD", 0.55, 0.86),
  ],
  "4-4-2": [
    s("GK", 0.025, 0.5),
    ...BACK_FOUR,
    s("MID", 0.38, 0.12),
    s("MID", 0.35, 0.38),
    s("MID", 0.35, 0.62),
    s("MID", 0.38, 0.88),
    s("FWD", 0.56, 0.38),
    s("FWD", 0.56, 0.62),
  ],
  "4-2-3-1": [
    s("GK", 0.025, 0.5),
    ...BACK_FOUR,
    s("MID", 0.32, 0.38),
    s("MID", 0.32, 0.62),
    s("MID", 0.46, 0.15),
    s("MID", 0.47, 0.5),
    s("MID", 0.46, 0.85),
    s("FWD", 0.6, 0.5),
  ],
  "3-5-2": [
    s("GK", 0.025, 0.5),
    s("DEF", 0.18, 0.25),
    s("DEF", 0.17, 0.5),
    s("DEF", 0.18, 0.75),
    s("MID", 0.4, 0.08),
    s("MID", 0.35, 0.33),
    s("MID", 0.31, 0.5),
    s("MID", 0.35, 0.67),
    s("MID", 0.4, 0.92),
    s("FWD", 0.57, 0.38),
    s("FWD", 0.57, 0.62),
  ],
};

export function isLegalFormation(slots: Slot[]): boolean {
  if (slots.length !== 11) return false;
  if (slots.filter((x) => x.role === "GK").length !== 1) return false;
  const def = slots.filter((x) => x.role === "DEF").length;
  return def >= 3 && def <= 5 && slots.every((x) => x.rx >= 0 && x.rx < 0.7 && x.ry > 0 && x.ry < 1);
}
