/**
 * Deterministic PRNG (sfc32). Uses only 32-bit integer operations, so the stream is identical in every JavaScript
 * engine. Never use Math.random anywhere in the simulation.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(words: readonly number[]) {
    if (words.length < 4) throw new Error("Rng needs four 32-bit seed words");
    this.a = words[0] >>> 0;
    this.b = words[1] >>> 0;
    this.c = words[2] >>> 0;
    this.d = words[3] >>> 0;
    for (let i = 0; i < 20; i++) this.u32();
  }

  u32(): number {
    const t0 = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const t = (t0 + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Approximately standard normal (Irwin–Hall, 4 terms). No Math.log, so it is bit-exact everywhere. */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508075688772;
  }
}

/** Splits a 32-byte hex seed into eight words and folds them into four. */
export function seedWords(hex: string): number[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("seed must be 32 bytes of hex");
  const w: number[] = [];
  for (let i = 0; i < 8; i++) w.push(parseInt(h.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return [(w[0] ^ w[4]) >>> 0, (w[1] ^ w[5]) >>> 0, (w[2] ^ w[6]) >>> 0, (w[3] ^ w[7]) >>> 0];
}

/** FNV-1a, for deriving stable sub-seeds from strings (team ids). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
