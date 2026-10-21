import { FORMATIONS, type FormationName, type Role } from "./formations";
import { Rng, fnv1a } from "./rng";

/** Attributes are integers 1..99. */
export interface Attributes {
  speed: number;
  acceleration: number;
  passing: number;
  ballControl: number;
  dribbling: number;
  shooting: number;
  finishing: number;
  tackling: number;
  marking: number;
  positioning: number;
  stamina: number;
  decisions: number;
  goalkeeping: number;
}

export interface PlayerConfig {
  number: number;
  name: string;
  role: Role;
  attrs: Attributes;
}

export interface TeamConfig {
  id: number;
  name: string;
  short: string;
  /** Primary and alternate kit colours (hex). */
  kit: [string, string];
  formation: FormationName;
  rating: number;
  players: PlayerConfig[];
}

interface TeamSeed {
  name: string;
  short: string;
  kit: [string, string];
  formation: FormationName;
  rating: number;
}

/** The league: twenty fictional clubs. Changing anything here requires an ENGINE_VERSION bump. */
const LEAGUE: TeamSeed[] = [
  { name: "Northvale Athletic", short: "NVA", kit: ["#E8E8EA", "#1F4FD1"], formation: "4-3-3", rating: 81 },
  { name: "Port Calder", short: "PCA", kit: ["#D7263D", "#F4F4F4"], formation: "4-2-3-1", rating: 80 },
  { name: "Redmoor United", short: "RMU", kit: ["#B3122E", "#111111"], formation: "4-4-2", rating: 78 },
  { name: "Ashbury Rovers", short: "ASH", kit: ["#2E7D32", "#F2F2F2"], formation: "4-3-3", rating: 77 },
  { name: "Kestrel City", short: "KES", kit: ["#4FA3E0", "#14213D"], formation: "4-2-3-1", rating: 79 },
  { name: "Lindhaven", short: "LIN", kit: ["#F2C14E", "#2B2B2B"], formation: "3-5-2", rating: 75 },
  { name: "Marrow Bay", short: "MAR", kit: ["#0B6E4F", "#F6AE2D"], formation: "4-4-2", rating: 74 },
  { name: "Old Ferris", short: "OFE", kit: ["#6A0DAD", "#EDEDED"], formation: "4-3-3", rating: 72 },
  { name: "Saltmere", short: "SAL", kit: ["#00A6A6", "#FFFFFF"], formation: "4-2-3-1", rating: 76 },
  { name: "Ironbridge Town", short: "IRT", kit: ["#5C5C66", "#F28F3B"], formation: "4-4-2", rating: 73 },
  { name: "Westerholm", short: "WES", kit: ["#F5F5F5", "#C1121F"], formation: "3-5-2", rating: 77 },
  { name: "Corvane", short: "COR", kit: ["#1D3557", "#E9C46A"], formation: "4-3-3", rating: 78 },
  { name: "Brackenridge", short: "BRA", kit: ["#8C4A2F", "#F1E3C8"], formation: "4-4-2", rating: 71 },
  { name: "Halden Forge", short: "HAL", kit: ["#FF7F11", "#1B1B1E"], formation: "4-2-3-1", rating: 74 },
  { name: "Stormlake", short: "STO", kit: ["#3A86FF", "#FFBE0B"], formation: "4-3-3", rating: 75 },
  { name: "Vellmouth", short: "VEL", kit: ["#9B2226", "#E9D8A6"], formation: "3-5-2", rating: 72 },
  { name: "Galloway Park", short: "GAL", kit: ["#2A9D8F", "#264653"], formation: "4-4-2", rating: 75 },
  { name: "Thistledown", short: "THI", kit: ["#7B2CBF", "#C7F9CC"], formation: "4-2-3-1", rating: 72 },
  { name: "Embercross", short: "EMB", kit: ["#E63946", "#F1FAEE"], formation: "4-3-3", rating: 80 },
  { name: "Quarry Lane", short: "QUA", kit: ["#495057", "#F8F9FA"], formation: "4-4-2", rating: 70 },
];

const FIRST = [
  "Arlo",
  "Bram",
  "Cael",
  "Dario",
  "Emil",
  "Fenn",
  "Gael",
  "Hugo",
  "Ivo",
  "Jory",
  "Kai",
  "Lior",
  "Milo",
  "Nico",
  "Orin",
  "Pell",
  "Quin",
  "Rafe",
  "Soren",
  "Teo",
  "Ulric",
  "Vito",
  "Wren",
  "Xan",
  "Yuri",
  "Zev",
  "Anders",
  "Bastian",
  "Cyrus",
  "Dane",
  "Elio",
  "Florin",
  "Goran",
  "Hale",
  "Ilan",
  "Jonas",
];
const LAST = [
  "Ashford",
  "Brennan",
  "Castell",
  "Dorsey",
  "Everly",
  "Falk",
  "Garrow",
  "Hollis",
  "Ingram",
  "Jansen",
  "Kovac",
  "Larkin",
  "Mercer",
  "Novak",
  "Okafor",
  "Petrov",
  "Quill",
  "Rourke",
  "Sallow",
  "Tamsin",
  "Ulloa",
  "Varga",
  "Whitlock",
  "Yarrow",
  "Zeller",
  "Adebayo",
  "Brandt",
  "Corso",
  "Delacroix",
  "Esposito",
  "Fairbairn",
  "Grisham",
  "Halloran",
];

/** Role profiles: offsets added to the team rating. */
const PROFILE: Record<Role, Partial<Record<keyof Attributes, number>>> = {
  GK: {
    goalkeeping: 6,
    positioning: 4,
    passing: -12,
    shooting: -40,
    finishing: -45,
    dribbling: -30,
    tackling: -30,
    speed: -15,
    acceleration: -8,
  },
  DEF: { tackling: 6, marking: 6, positioning: 4, finishing: -22, shooting: -16, dribbling: -10, goalkeeping: -60 },
  MID: { passing: 6, decisions: 5, ballControl: 4, stamina: 6, finishing: -8, goalkeeping: -60 },
  FWD: { finishing: 7, shooting: 6, dribbling: 5, speed: 4, tackling: -22, marking: -24, goalkeeping: -60 },
};

const ATTR_KEYS: (keyof Attributes)[] = [
  "speed",
  "acceleration",
  "passing",
  "ballControl",
  "dribbling",
  "shooting",
  "finishing",
  "tackling",
  "marking",
  "positioning",
  "stamina",
  "decisions",
  "goalkeeping",
];

function buildTeam(id: number, seed: TeamSeed): TeamConfig {
  const rng = new Rng([fnv1a(seed.name), fnv1a(seed.short), id * 7919, 0x0dd2a]);
  const slots = FORMATIONS[seed.formation];
  const used = new Set<string>();
  const players: PlayerConfig[] = slots.map((slot, i) => {
    let name = "";
    do name = `${FIRST[rng.int(FIRST.length)]} ${LAST[rng.int(LAST.length)]}`;
    while (used.has(name));
    used.add(name);
    const prof = PROFILE[slot.role];
    const attrs = {} as Attributes;
    for (const k of ATTR_KEYS) {
      const v = seed.rating + (prof[k] ?? 0) + Math.round(rng.normal() * 4);
      attrs[k] = Math.max(1, Math.min(99, v));
    }
    return { number: i === 0 ? 1 : i + 1, name, role: slot.role, attrs };
  });
  return {
    id,
    name: seed.name,
    short: seed.short,
    kit: seed.kit,
    formation: seed.formation,
    rating: seed.rating,
    players,
  };
}

export const TEAMS: readonly TeamConfig[] = LEAGUE.map((t, i) => buildTeam(i, t));

export function team(id: number): TeamConfig {
  const t = TEAMS[id];
  if (!t) throw new Error(`unknown team ${id}`);
  return t;
}
