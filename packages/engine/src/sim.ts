/**
 * The Oddra match engine.
 *
 * Determinism rules (see docs/SIMULATION.md):
 *  - all randomness comes from one seeded Rng, consumed in a fixed order;
 *  - arithmetic is limited to + - * / Math.sqrt / abs / min / max / floor / round, which IEEE-754 makes bit-exact
 *    in every JavaScript engine (no trig, exp, log or pow, whose results may differ by platform);
 *  - every loop runs over arrays in index order.
 */
import { DT, FRAME_COUNT, FRAME_EVERY, FRAME_STRIDE, HALF_TICKS, PITCH, TOTAL_TICKS } from "./constants";
import { FORMATIONS, type Role, type Slot } from "./formations";
import { Rng, seedWords } from "./rng";
import type { Attributes } from "./teams";
import type { EventType, MatchConfig, MatchEvent, MatchResult, TeamStats } from "./types";

const L: number = PITCH.L;
const W: number = PITCH.W;
const CY: number = PITCH.cy;
const GOAL_Y0 = CY - PITCH.goalHalfW;
const GOAL_Y1 = CY + PITCH.goalHalfW;
const G = 9.81;
const ROLL_DECEL = 2.6;
const FREE_KICK_DISTANCE = 9.15;
/** The value teams place on simply keeping the ball; it makes risky passes and speculative shots costly. */
const KEEP = 0.045;

type FlightKind = "pass" | "through" | "long" | "cross" | "throw" | "shot" | "clear" | "loose";
type RestartType = "kickoff" | "throw_in" | "goal_kick" | "corner" | "free_kick" | "penalty";

interface Norm {
  spd: number;
  acc: number;
  pas: number;
  ctl: number;
  dri: number;
  sho: number;
  fin: number;
  tck: number;
  mrk: number;
  pos: number;
  sta: number;
  dec: number;
  gk: number;
}

interface Player {
  i: number;
  team: 0 | 1;
  role: Role;
  slot: Slot;
  a: Norm;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  sprint: boolean;
  stamina: number;
  tackleCd: number;
  touchCd: number;
  decisionCd: number;
  runTicks: number;
}

interface Flight {
  kind: FlightKind;
  team: 0 | 1;
  from: number;
  to: number;
  tx: number;
  ty: number;
  // shots
  onTarget: boolean;
  blockAt: number;
  blocker: number;
  traveled: number;
  saveAtX: number;
  saveOutcome: 0 | 1 | 2; // 0 none, 1 catch, 2 parry
  header: boolean;
  est: number;
  ox: number;
  oy: number;
}

interface Restart {
  type: RestartType;
  team: 0 | 1;
  x: number;
  y: number;
  timer: number;
  taker: number;
}

const norm = (a: Attributes): Norm => ({
  spd: a.speed / 100,
  acc: a.acceleration / 100,
  pas: a.passing / 100,
  ctl: a.ballControl / 100,
  dri: a.dribbling / 100,
  sho: a.shooting / 100,
  fin: a.finishing / 100,
  tck: a.tackling / 100,
  mrk: a.marking / 100,
  pos: a.positioning / 100,
  sta: a.stamina / 100,
  dec: a.decisions / 100,
  gk: a.goalkeeping / 100,
});

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

export class Simulation {
  readonly rng: Rng;
  readonly players: Player[] = [];
  tick = 0;
  half = 0;
  score: [number, number] = [0, 0];
  firstScorer: -1 | 0 | 1 = -1;
  state: "play" | "dead" | "over" = "dead";
  restart: Restart | null = null;

  bx = L / 2;
  by = CY;
  bz = 0;
  bvx = 0;
  bvy = 0;
  bvz = 0;
  pbx = L / 2;
  pby = CY;
  pbz = 0;
  owner = -1;
  lastTeam: -1 | 0 | 1 = -1;
  lastPlayer = -1;
  flight: Flight | null = null;
  gkHold = 0;
  lastPass: { team: number; from: number; to: number; tick: number } | null = null;

  /** Diagnostic counters only; never read by the simulation. */
  readonly debug: Record<string, number> = {};
  readonly events: MatchEvent[] = [];
  readonly possTicks: [number, number] = [0, 0];
  readonly frames = new Int16Array(FRAME_COUNT * FRAME_STRIDE);
  readonly owners = new Int8Array(FRAME_COUNT);

  constructor(
    readonly config: MatchConfig,
    readonly seed: string,
  ) {
    this.rng = new Rng(seedWords(seed));
    const teams = [config.home, config.away];
    for (let t = 0 as 0 | 1; t < 2; t = (t + 1) as 0 | 1) {
      const team = teams[t];
      const slots = FORMATIONS[team.formation];
      for (let k = 0; k < 11; k++) {
        this.players.push({
          i: t * 11 + k,
          team: t,
          role: slots[k].role,
          slot: slots[k],
          a: norm(team.players[k].attrs),
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          fx: t === 0 ? 1 : -1,
          fy: 0,
          tx: 0,
          ty: 0,
          sprint: false,
          stamina: 1,
          tackleCd: 0,
          touchCd: 0,
          decisionCd: 0,
          runTicks: 0,
        });
      }
    }
    this.kickoffShape(true);
    this.setRestart("kickoff", 0, L / 2, CY, 20);
    this.recordFrame();
  }

  // ---------------------------------------------------------------- geometry

  /** +1 if the team attacks towards x = L in the current half. */
  dir(team: number): number {
    return (team === 0) === (this.half === 0) ? 1 : -1;
  }
  relX(team: number, x: number): number {
    return this.dir(team) > 0 ? x / L : (L - x) / L;
  }
  relY(team: number, y: number): number {
    return this.dir(team) > 0 ? y / W : (W - y) / W;
  }
  absX(team: number, rx: number): number {
    return this.dir(team) > 0 ? rx * L : L - rx * L;
  }
  absY(team: number, ry: number): number {
    return this.dir(team) > 0 ? ry * W : W - ry * W;
  }
  goalX(team: number): number {
    return this.dir(team) > 0 ? L : 0;
  }
  ownGoalX(team: number): number {
    return this.dir(team) > 0 ? 0 : L;
  }
  inOwnBox(team: number, x: number, y: number): boolean {
    const gx = this.ownGoalX(team);
    return Math.abs(x - gx) <= PITCH.boxDepth && Math.abs(y - CY) <= PITCH.boxHalfW;
  }
  gkOf(team: number): Player {
    return this.players[team * 11];
  }

  // ---------------------------------------------------------------- events

  emit(type: EventType, team: -1 | 0 | 1, player: number, other: number, ok: boolean, x: number, y: number) {
    this.events.push({
      seq: this.events.length,
      tick: this.tick,
      type,
      team,
      player,
      other,
      ok,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      home: this.score[0],
      away: this.score[1],
    });
  }

  // ---------------------------------------------------------------- main loop

  run(): MatchResult {
    while (this.state !== "over") this.step();
    return this.result();
  }

  step() {
    if (this.state === "over") return;
    if (this.state === "dead") this.deadStep();
    else this.playStep();
    for (const p of this.players) {
      if (p.tackleCd > 0) p.tackleCd--;
      if (p.touchCd > 0) p.touchCd--;
      if (p.runTicks > 0) p.runTicks--;
    }
    this.tick++;
    if (this.tick % FRAME_EVERY === 0) this.recordFrame();
    if (this.tick === HALF_TICKS) this.halftime();
    else if (this.tick >= TOTAL_TICKS) this.fulltime();
  }

  private recordFrame() {
    const f = this.tick / FRAME_EVERY;
    const o = f * FRAME_STRIDE;
    for (let k = 0; k < 22; k++) {
      const p = this.players[k];
      this.frames[o + k * 2] = Math.round(p.x * 10);
      this.frames[o + k * 2 + 1] = Math.round(p.y * 10);
    }
    this.frames[o + 44] = Math.round(this.bx * 10);
    this.frames[o + 45] = Math.round(this.by * 10);
    this.frames[o + 46] = Math.round(this.bz * 10);
    this.owners[f] = this.owner;
  }

  private halftime() {
    this.emit("halftime", -1, -1, -1, true, L / 2, CY);
    this.half = 1;
    this.flight = null;
    this.owner = -1;
    for (const p of this.players) p.stamina = Math.min(1, p.stamina + 0.25);
    this.kickoffShape(true);
    this.setRestart("kickoff", 1, L / 2, CY, 20);
  }

  private fulltime() {
    this.emit("fulltime", -1, -1, -1, true, this.bx, this.by);
    this.state = "over";
  }

  // ---------------------------------------------------------------- dead balls

  private setRestart(type: RestartType, team: 0 | 1, x: number, y: number, timer: number) {
    this.state = "dead";
    this.owner = -1;
    this.flight = null;
    this.gkHold = 0;
    this.bvx = this.bvy = this.bvz = 0;
    this.bz = 0;
    this.bx = clamp(x, 0, L);
    this.by = clamp(y, 0, W);
    this.restart = { type, team, x: this.bx, y: this.by, timer, taker: this.pickTaker(type, team) };
  }

  private pickTaker(type: RestartType, team: 0 | 1): number {
    const base = team * 11;
    if (type === "goal_kick") return base;
    let best = -1;
    let bestScore = -Infinity;
    for (let k = 1; k < 11; k++) {
      const p = this.players[base + k];
      let sc: number;
      if (type === "penalty") sc = p.a.fin * 2 + p.a.sho;
      else if (type === "corner") sc = p.a.pas * 2 - (p.role === "FWD" ? 1 : 0) - (p.role === "DEF" ? 0.6 : 0);
      else if (type === "kickoff") sc = p.role === "FWD" ? 2 - hyp(p.x - L / 2, p.y - CY) * 0.01 : 0;
      else sc = -hyp(p.x - this.bx, p.y - this.by) + (type === "free_kick" ? p.a.pas * 6 : 0);
      if (sc > bestScore) {
        bestScore = sc;
        best = base + k;
      }
    }
    return best;
  }

  private kickoffShape(teleport: boolean) {
    for (const p of this.players) {
      const rx = p.role === "GK" ? 0.025 : Math.min(0.46, p.slot.rx * 0.82);
      const x = this.absX(p.team, rx);
      const y = this.absY(p.team, p.slot.ry);
      p.tx = x;
      p.ty = y;
      if (teleport) {
        p.x = x;
        p.y = y;
        p.vx = p.vy = 0;
      }
    }
  }

  private deadStep() {
    const r = this.restart!;
    r.timer--;
    this.computeTargets(r.x, r.y, r.team, true);
    const taker = this.players[r.taker];
    // the taker walks to the ball
    taker.tx = r.x - this.dir(r.team) * 0.6;
    taker.ty = r.y;
    taker.sprint = true;
    this.movePlayers(-1);
    if (r.timer <= 0) this.executeRestart(r);
  }

  private executeRestart(r: Restart) {
    const taker = this.players[r.taker];
    taker.x = clamp(r.x - this.dir(r.team) * 0.4, 0.2, L - 0.2);
    taker.y = clamp(r.y, 0.2, W - 0.2);
    taker.vx = taker.vy = 0;
    this.bx = r.x;
    this.by = r.y;
    this.bz = 0;
    this.restart = null;
    this.state = "play";
    this.lastTeam = r.team;
    this.lastPlayer = taker.i;
    switch (r.type) {
      case "kickoff": {
        this.emit("kickoff", r.team, taker.i, -1, true, r.x, r.y);
        const mate = this.nearestTeammate(taker, (q) => q.role === "MID");
        this.kickPass(taker, mate, "pass", false);
        break;
      }
      case "throw_in": {
        this.emit("throw_in", r.team, taker.i, -1, true, r.x, r.y);
        const target = this.bestPassTarget(taker, 22);
        this.kickPass(taker, target, "throw", false);
        break;
      }
      case "goal_kick": {
        this.emit("goal_kick", r.team, taker.i, -1, true, r.x, r.y);
        const target = this.bestPassTarget(taker, 60);
        this.kickPass(taker, target, hyp(target.x - taker.x, target.y - taker.y) > 28 ? "long" : "pass", false);
        break;
      }
      case "corner": {
        this.emit("corner", r.team, taker.i, -1, true, r.x, r.y);
        this.cross(taker);
        break;
      }
      case "free_kick": {
        this.emit("free_kick", r.team, taker.i, -1, true, r.x, r.y);
        const d = hyp(this.goalX(r.team) - r.x, CY - r.y);
        if (d < 30 && this.xgAt(r.team, r.x, r.y) > 0.045) this.shoot(taker, "free_kick");
        else if (this.relX(r.team, r.x) > 0.68) this.cross(taker);
        else {
          const target = this.bestPassTarget(taker, 40);
          this.kickPass(taker, target, hyp(target.x - taker.x, target.y - taker.y) > 28 ? "long" : "pass", false);
        }
        break;
      }
      case "penalty": {
        this.emit("penalty", r.team, taker.i, -1, true, r.x, r.y);
        this.shoot(taker, "penalty");
        break;
      }
    }
  }

  // ---------------------------------------------------------------- open play

  private playStep() {
    if (this.owner >= 0) this.carrierThink(this.players[this.owner]);
    const possTeam = this.possessionTeam();
    this.computeTargets(this.bx, this.by, possTeam, false);
    this.movePlayers(this.owner);
    if (this.owner >= 0) {
      this.attachBall();
      this.tackles();
    } else {
      this.pbx = this.bx;
      this.pby = this.by;
      this.pbz = this.bz;
      this.integrateBall();
      this.flightChecks();
      if (this.state === "play" && this.owner < 0) this.checkOut();
      if (this.state === "play" && this.owner < 0) this.controlChecks();
    }
    if (this.state === "play") {
      const t = this.possessionTeam();
      if (t !== -1) this.possTicks[t]++;
    }
  }

  possessionTeam(): -1 | 0 | 1 {
    if (this.owner >= 0) return this.players[this.owner].team;
    if (this.flight && this.flight.kind !== "loose" && this.flight.kind !== "shot" && this.flight.kind !== "clear")
      return this.flight.team;
    return this.lastTeam;
  }

  private attachBall() {
    const c = this.players[this.owner];
    this.bx = c.x + c.fx * 0.45;
    this.by = c.y + c.fy * 0.45;
    this.bz = 0;
    this.bvx = c.vx;
    this.bvy = c.vy;
    this.bvz = 0;
  }

  /** One integration step; shared by the live ball and by shot prediction so both agree exactly. */
  static integrate(b: { x: number; y: number; z: number; vx: number; vy: number; vz: number }) {
    if (b.z > 0 || b.vz !== 0) {
      b.z += b.vz * DT;
      b.vz -= G * DT;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -1.6) {
          b.vz = -b.vz * 0.4;
          b.vx *= 0.62;
          b.vy *= 0.62;
        } else b.vz = 0;
      }
      b.vx *= 0.997;
      b.vy *= 0.997;
    } else {
      const sp = hyp(b.vx, b.vy);
      if (sp > 0) {
        const ns = Math.max(0, sp - ROLL_DECEL * DT);
        b.vx = (b.vx / sp) * ns;
        b.vy = (b.vy / sp) * ns;
      }
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  private integrateBall() {
    const b = { x: this.bx, y: this.by, z: this.bz, vx: this.bvx, vy: this.bvy, vz: this.bvz };
    Simulation.integrate(b);
    this.bx = b.x;
    this.by = b.y;
    this.bz = b.z;
    this.bvx = b.vx;
    this.bvy = b.vy;
    this.bvz = b.vz;
    if (this.flight && this.flight.kind !== "loose" && hyp(this.bvx, this.bvy) < 0.6 && this.bz === 0) {
      // the ball died before anyone reached it
      this.resolvePassFailed("died");
      this.flight.kind = "loose";
    }
  }

  // ---------------------------------------------------------------- shots in flight

  private flightChecks() {
    const f = this.flight;
    if (!f || f.kind !== "shot") return;
    const step = hyp(this.bx - this.pbx, this.by - this.pby);
    f.traveled += step;
    if (f.blocker >= 0 && f.traveled >= f.blockAt) {
      const q = this.players[f.blocker];
      this.bx = q.x;
      this.by = q.y;
      this.emit("block", q.team, q.i, f.from, true, this.bx, this.by);
      const sp = hyp(this.bvx, this.bvy) * this.rng.range(0.2, 0.45);
      const dx = this.dir(f.team) * (this.rng.chance(0.4) ? this.rng.range(0.3, 1) : -this.rng.range(0.1, 1));
      const dy = this.rng.range(-1, 1);
      const n = hyp(dx, dy) || 1;
      this.bvx = (dx / n) * sp;
      this.bvy = (dy / n) * sp;
      this.bvz = this.rng.range(0, 4);
      this.lastTeam = q.team;
      this.lastPlayer = q.i;
      f.kind = "loose";
      q.touchCd = 4;
      return;
    }
    if (f.saveOutcome !== 0) {
      const gk = this.gkOf(1 - f.team);
      const crossed = this.dir(f.team) > 0 ? this.bx >= f.saveAtX : this.bx <= f.saveAtX;
      if (crossed) {
        const k = (f.saveAtX - this.pbx) / (this.bx - this.pbx || 1e-9);
        this.bx = f.saveAtX;
        this.by = this.pby + k * (this.by - this.pby);
        this.bz = Math.max(0, this.pbz + k * (this.bz - this.pbz));
        this.emit("save", gk.team, gk.i, f.from, true, this.bx, this.by);
        this.lastTeam = gk.team;
        this.lastPlayer = gk.i;
        if (f.saveOutcome === 1) {
          this.gainControl(gk, true);
        } else {
          const round = this.rng.chance(0.55);
          const sp = hyp(this.bvx, this.bvy) * this.rng.range(0.25, 0.5);
          const side = this.by >= CY ? 1 : -1;
          let dx: number;
          let dy: number;
          if (round) {
            // tipped round the post: cross the goal line clear of it
            const dist = Math.max(0.3, Math.abs(this.goalX(f.team) - this.bx));
            const need = Math.max(0.6, PITCH.goalHalfW + 0.8 - Math.abs(this.by - CY));
            dx = this.dir(f.team) * dist;
            dy = side * need * this.rng.range(1.3, 2.2);
          } else {
            dx = -this.dir(f.team) * this.rng.range(0.3, 1);
            dy = side * this.rng.range(0.4, 1.4);
          }
          const n = hyp(dx, dy);
          this.bvx = (dx / n) * sp;
          this.bvy = (dy / n) * sp;
          this.bvz = this.rng.range(0.5, 4);
          this.flight!.kind = "loose";
          gk.touchCd = 8;
        }
      }
    }
  }

  // ---------------------------------------------------------------- restarts from the ball leaving play

  private checkOut() {
    const outX = this.bx < 0 || this.bx > L;
    const outY = this.by < 0 || this.by > W;
    if (!outX && !outY) return;
    if (outX) {
      const side = this.bx < 0 ? 0 : L;
      const f = (side - this.pbx) / (this.bx - this.pbx || 1e-9);
      const yc = this.pby + f * (this.by - this.pby);
      const zc = this.pbz + f * (this.bz - this.pbz);
      const defending: 0 | 1 = this.ownGoalX(0) === side ? 0 : 1;
      const attacking: 0 | 1 = defending === 0 ? 1 : 0;
      if (yc > GOAL_Y0 && yc < GOAL_Y1 && zc < PITCH.goalH && yc >= 0 && yc <= W) {
        this.goal(attacking, side, yc);
        return;
      }
      this.resolvePassFailed("goalline");
      if (this.lastTeam === attacking || this.lastTeam === -1) {
        this.setRestart(
          "goal_kick",
          defending,
          side === 0 ? 5.5 : L - 5.5,
          this.rng.chance(0.5) ? CY - 9 : CY + 9,
          200,
        );
      } else {
        const cy = yc < CY ? 0.3 : W - 0.3;
        this.setRestart("corner", attacking, side === 0 ? 0.3 : L - 0.3, cy, 260);
      }
      return;
    }
    this.resolvePassFailed("touch");
    const team: 0 | 1 = this.lastTeam === 0 ? 1 : 0;
    this.setRestart("throw_in", team, clamp(this.bx, 1, L - 1), this.by < 0 ? 0 : W, 130);
  }

  private goal(team: 0 | 1, side: number, y: number) {
    this.score[team]++;
    if (this.firstScorer < 0) this.firstScorer = team;
    const scorer = this.lastTeam === team ? this.lastPlayer : -1;
    let assist = -1;
    if (
      this.lastPass &&
      this.lastPass.team === team &&
      this.lastPass.to === scorer &&
      this.tick - this.lastPass.tick < 120 &&
      this.lastPass.from !== scorer
    )
      assist = this.lastPass.from;
    this.emit("goal", team, scorer, assist, true, side, y);
    this.lastPass = null;
    this.kickoffShape(false);
    this.setRestart("kickoff", team === 0 ? 1 : 0, L / 2, CY, 450);
  }

  // ---------------------------------------------------------------- receiving

  private controlChecks() {
    const f = this.flight;
    // candidates sorted by distance from the ball's path this step
    const cands: { p: Player; d: number }[] = [];
    const sx = this.bx - this.pbx;
    const sy = this.by - this.pby;
    const sl2 = sx * sx + sy * sy;
    for (const p of this.players) {
      if (p.touchCd > 0) continue;
      let t = sl2 > 0 ? ((p.x - this.pbx) * sx + (p.y - this.pby) * sy) / sl2 : 1;
      t = clamp(t, 0, 1);
      const d = hyp(this.pbx + sx * t - p.x, this.pby + sy * t - p.y);
      if (d < 2.2) cands.push({ p, d });
    }
    if (cands.length === 0) return;
    cands.sort((u, v) => u.d - v.d || u.p.i - v.p.i);
    const speed = hyp(this.bvx, this.bvy);
    for (const { p, d } of cands) {
      const isGk = p.role === "GK" && this.inOwnBox(p.team, p.x, p.y);
      const reach = isGk ? 1.7 : 0.95 + p.a.ctl * 0.25;
      if (d > reach) continue;
      const maxZ = isGk ? 2.7 : 2.3;
      if (this.bz > maxZ) continue;
      const header = this.bz > 1.0;
      if (header && f && f.kind !== "loose" && f.kind !== "clear" && f.kind !== "cross" && p.team === f.team) continue;
      // a pass has to get past the man pressing the passer before anyone can cut it out
      if (f && f.kind !== "loose" && p.team !== f.team && hyp(this.bx - f.ox, this.by - f.oy) < 2.5) continue;
      if (f && f.kind === "shot") {
        // outfield players only meet a shot through the pre-computed block; keepers through the save.
        continue;
      }
      let pc: number;
      const fast = Math.max(0, speed - 11) * 0.035;
      if (header) {
        pc = 0.55 + 0.25 * p.a.pos - (isGk ? -0.25 : 0);
      } else if (!f || f.kind === "loose" || f.kind === "clear") {
        pc = 0.55 + 0.35 * p.a.ctl - fast;
      } else if (p.team === f.team) {
        pc = (p.i === f.to ? 0.93 : 0.7) + 0.07 * p.a.ctl - fast;
      } else {
        pc = 0.12 + 0.25 * (p.a.tck + p.a.pos) * 0.5 - fast * 0.5 + (isGk ? 0.4 : 0);
      }
      if (this.rng.chance(clamp(pc, 0.03, 0.98))) {
        if (header && !(isGk && p.team !== this.lastTeam)) this.header(p);
        else this.gainControl(p, isGk && this.lastTeam !== p.team);
        return;
      }
      // a miscontrol or a touch that changes the ball's path
      const opponent = f && f.kind !== "loose" && p.team !== f.team;
      p.touchCd = opponent ? 14 : 5;
      if (opponent && this.rng.chance(0.8)) continue;
      if (speed > 3 && (!f || p.team !== f.team || p.i === f.to)) {
        const k = this.rng.range(0.45, 0.8);
        const nx = this.bvx * k + this.rng.normal() * 1.2;
        const ny = this.bvy * k + this.rng.normal() * 1.2;
        this.bvx = nx;
        this.bvy = ny;
        if (f && f.kind !== "loose") {
          this.resolvePassFailed(p.team === f.team ? "miscontrol" : "deflect");
          f.kind = "loose";
        }
        this.lastTeam = p.team;
        this.lastPlayer = p.i;
        return;
      }
    }
  }

  private dbg(k: string) {
    this.debug[k] = (this.debug[k] ?? 0) + 1;
  }

  private resolvePassFailed(reason = "other") {
    const f = this.flight;
    if (!f || f.kind === "loose" || f.kind === "shot" || f.kind === "clear") return;
    this.dbg("fail_" + reason + "_" + f.kind);
    if (f.est >= 0) this.dbg(`cal_${Math.floor(f.est * 10)}_fail`);
    const kind: EventType = f.kind === "cross" ? "cross" : "pass";
    this.emit(kind, f.team, f.from, f.to, false, this.bx, this.by);
  }

  private gainControl(p: Player, hands: boolean) {
    const f = this.flight;
    if (f && f.kind !== "loose" && f.kind !== "shot" && f.kind !== "clear") {
      const kind: EventType = f.kind === "cross" ? "cross" : "pass";
      if (f.est >= 0) this.dbg(`cal_${Math.floor(f.est * 10)}_${p.team === f.team ? "ok" : "fail"}`);
      if (p.team === f.team) {
        this.emit(kind, f.team, f.from, p.i, true, p.x, p.y);
        this.lastPass = { team: f.team, from: f.from, to: p.i, tick: this.tick };
      } else {
        this.dbg("fail_intercept_" + f.kind);
        this.emit(kind, f.team, f.from, p.i, false, p.x, p.y);
        this.emit("interception", p.team, p.i, f.from, true, p.x, p.y);
      }
    } else if (this.lastTeam >= 0 && this.lastTeam !== p.team && f && f.kind === "loose" && !hands) {
      // regaining a loose ball after an opponent's touch
    }
    this.flight = null;
    this.owner = p.i;
    this.lastTeam = p.team;
    this.lastPlayer = p.i;
    this.bz = 0;
    this.bvz = 0;
    p.decisionCd = 8 + this.rng.int(9);
    p.fx = this.dir(p.team);
    p.fy = 0;
    this.gkHold = hands ? 25 + this.rng.int(35) : 0;
    if (!hands) this.attachBall();
    else {
      this.bx = p.x;
      this.by = p.y;
      this.bvx = this.bvy = 0;
    }
  }

  private header(p: Player) {
    const team = p.team;
    const rx = this.relX(team, p.x);
    const central = Math.abs(p.y - CY) < 12;
    const f = this.flight;
    if (f && f.kind !== "loose" && f.kind !== "clear" && f.team === team) {
      this.emit(f.kind === "cross" ? "cross" : "pass", f.team, f.from, p.i, true, p.x, p.y);
      this.lastPass = { team: f.team, from: f.from, to: p.i, tick: this.tick };
    } else if (f && f.kind !== "loose" && f.kind !== "clear") {
      this.emit(f.kind === "cross" ? "cross" : "pass", f.team, f.from, p.i, false, p.x, p.y);
    }
    this.lastTeam = team;
    this.lastPlayer = p.i;
    p.touchCd = 6;
    if (rx > 0.86 && central) {
      this.flight = null;
      this.shoot(p, "header");
      return;
    }
    // defensive header or knock-down: away from the own goal, or behind for a corner under pressure
    const behind = rx < 0.17 && this.rng.chance(0.3);
    const dx = behind ? -this.dir(team) * this.rng.range(0.4, 0.8) : this.dir(team) * this.rng.range(0.6, 1.2);
    const dy = behind ? (p.y >= CY ? 1 : -1) * this.rng.range(0.8, 1.4) : this.rng.range(-0.8, 0.8);
    const n = hyp(dx, dy);
    const sp = this.rng.range(9, 15);
    this.bvx = (dx / n) * sp;
    this.bvy = (dy / n) * sp;
    this.bvz = this.rng.range(2, 6);
    if (rx < 0.4) this.emit("clearance", team, p.i, -1, true, p.x, p.y);
    this.flight = this.newFlight("clear", team, p.i, -1, this.bx + this.bvx, this.by + this.bvy);
  }

  // ---------------------------------------------------------------- tackles and fouls

  private tackles() {
    const c = this.players[this.owner];
    if (this.gkHold > 0) return;
    for (const q of this.players) {
      if (q.team === c.team || q.tackleCd > 0) continue;
      const d = hyp(q.x - c.x, q.y - c.y);
      if (d > 1.5) continue;
      if (q.role === "GK") {
        if (!this.inOwnBox(q.team, c.x, c.y) || !this.rng.chance(0.3)) continue;
        q.tackleCd = 15;
        if (this.rng.chance(0.3 + 0.4 * q.a.gk - 0.2 * c.a.dri)) {
          this.emit("save", q.team, q.i, c.i, true, c.x, c.y);
          c.touchCd = 10;
          this.gainControl(q, true);
          return;
        }
        continue;
      }
      const inBox = this.inOwnBox(q.team, c.x, c.y);
      const defThird = this.relX(q.team, c.x) < 0.33;
      if (!this.rng.chance(inBox ? 0.2 : defThird ? 0.18 : 0.13)) continue;
      q.tackleCd = 28;
      const win = clamp(0.36 + 0.5 * q.a.tck - 0.36 * c.a.dri - 0.1 * c.a.ctl, 0.08, 0.8);
      if (this.rng.chance(win)) {
        this.emit("tackle", q.team, q.i, c.i, true, c.x, c.y);
        c.touchCd = 10;
        c.decisionCd = 6;
        if (this.rng.chance(0.55)) {
          this.gainControl(q, false);
        } else {
          this.owner = -1;
          const sp = this.rng.range(2.5, 6);
          const dx = this.rng.normal();
          const dy = this.rng.normal();
          const n = hyp(dx, dy) || 1;
          this.bvx = (dx / n) * sp;
          this.bvy = (dy / n) * sp;
          this.lastTeam = q.team;
          this.lastPlayer = q.i;
          q.touchCd = 3;
          this.flight = this.newFlight("loose", q.team, q.i, -1, this.bx, this.by);
        }
        return;
      }
      const foul = (0.2 + 0.25 * (1 - q.a.tck)) * (inBox ? 0.22 : 1);
      if (this.rng.chance(foul)) {
        this.emit("foul", q.team, q.i, c.i, true, c.x, c.y);
        if (this.inOwnBox(q.team, c.x, c.y)) {
          const gx = this.ownGoalX(q.team);
          this.setRestart("penalty", c.team, gx === 0 ? PITCH.penSpot : L - PITCH.penSpot, CY, 600);
        } else {
          this.setRestart("free_kick", c.team, c.x, c.y, 220);
        }
        return;
      }
      this.emit("tackle", q.team, q.i, c.i, false, c.x, c.y);
    }
  }

  // ---------------------------------------------------------------- the player on the ball

  xgAt(team: number, x: number, y: number): number {
    const dx = Math.abs(this.goalX(team) - x);
    const dy = Math.abs(y - CY);
    const d = hyp(dx, dy);
    if (d > 36) return 0.002;
    const cos = dx / Math.max(d, 0.1);
    const r = d / 7.6;
    const far = d > 18 ? Math.max(0.25, 1 - (d - 18) * 0.035) : 1;
    return (0.82 / (1 + r * r)) * (0.15 + 0.85 * cos * cos) * far;
  }

  /** Value of having the ball at (x, y) for a team: a smooth proxy for the chance it leads to a goal. */
  value(team: number, x: number, y: number): number {
    const r = clamp(this.relX(team, x), 0, 1);
    const ry = this.relY(team, y);
    const centrality = 1 - Math.abs(ry - 0.5) * 0.6;
    return 0.004 + 0.034 * r * r * centrality + (r > 0.7 ? this.xgAt(team, x, y) * 0.55 : 0);
  }

  private pressureOn(p: Player): { near: number; count: number } {
    let near = 99;
    let count = 0;
    for (const q of this.players) {
      if (q.team === p.team) continue;
      const d = hyp(q.x - p.x, q.y - p.y);
      if (d < near) near = d;
      if (d < 4) count++;
    }
    return { near, count };
  }

  private carrierThink(c: Player) {
    if (this.gkHold > 0) {
      this.gkHold--;
      c.tx = c.x;
      c.ty = c.y;
      if (this.gkHold === 0) {
        const target = this.bestPassTarget(c, 65);
        this.kickPass(c, target, hyp(target.x - c.x, target.y - c.y) > 28 ? "long" : "pass", true);
      }
      return;
    }
    c.decisionCd--;
    const pr = this.pressureOn(c);
    if (c.decisionCd > 0 && !(pr.near < 1.6 && c.decisionCd > 2)) {
      this.dribbleTarget(c, pr.near);
      return;
    }
    this.decide(c, pr);
  }

  private dribbleTarget(c: Player, near: number) {
    // carry the ball towards goal, bending away from the nearest opponent
    let ax = this.goalX(c.team) - c.x;
    let ay = (CY - c.y) * 0.5;
    const n0 = hyp(ax, ay) || 1;
    ax /= n0;
    ay /= n0;
    if (near < 6) {
      let ox = 0;
      let oy = 0;
      for (const q of this.players) {
        if (q.team === c.team) continue;
        const dx = c.x - q.x;
        const dy = c.y - q.y;
        const d = hyp(dx, dy);
        if (d < 6 && d > 0.01) {
          const w = (6 - d) / 6 / d;
          ox += dx * w;
          oy += dy * w;
        }
      }
      ax += ox * 0.9;
      ay += oy * 0.9;
    }
    const n = hyp(ax, ay) || 1;
    c.tx = clamp(c.x + (ax / n) * 4, 0.5, L - 0.5);
    c.ty = clamp(c.y + (ay / n) * 4, 0.5, W - 0.5);
    c.sprint = near > 3;
  }

  private decide(c: Player, pr: { near: number; count: number }) {
    const team = c.team;
    const noise = 0.0055 * (1.3 - c.a.dec);
    const rx = this.relX(team, c.x);
    const vOpp = this.value(team === 0 ? 1 : 0, c.x, c.y);

    // shoot: discounted for every defender standing between the ball and the goal
    const tight = pr.near < 1.5 ? 0.45 : pr.near < 3 ? 0.7 : 1;
    let xg = this.xgAt(team, c.x, c.y) * (0.65 + 0.55 * c.a.fin) * tight * (1 - 0.1 * Math.min(pr.count, 3));
    const blockers = this.coneBlockers(team, c.x, c.y);
    for (let k = 0; k < blockers; k++) xg *= 0.55;
    let best = xg * 0.9 - (1 - xg) * (vOpp * 0.3 + KEEP * 0.5) + this.rng.normal() * noise;
    let action: "shoot" | "pass" | "dribble" | "cross" | "clear" = "shoot";
    if (hyp(this.goalX(team) - c.x, CY - c.y) > 33) best = -1;

    // dribble
    const inBox = this.inOwnBox(team === 0 ? 1 : 0, c.x, c.y);
    const pKeep = clamp(
      0.95 - (pr.near < 3 ? (3 - pr.near) * (0.3 - 0.18 * c.a.dri) : 0) - pr.count * 0.04 - (inBox ? 0.18 : 0),
      0.2,
      0.97,
    );
    const fx = c.x + this.dir(team) * (pr.near > 6 ? 9 : pr.near > 3.5 ? 6 : 4);
    const vDribble =
      pKeep * (this.value(team, fx, c.y) + KEEP) - (1 - pKeep) * (vOpp + KEEP) + this.rng.normal() * noise;
    if (vDribble > best) {
      best = vDribble;
      action = "dribble";
    }

    // pass
    let passTarget: Player | null = null;
    let passKind: FlightKind = "pass";
    let passPoint = { x: 0, y: 0 };
    let passEst = 0;
    for (const m of this.players) {
      if (m.team !== team || m.i === c.i) continue;
      if (m.role === "GK" && !(rx < 0.3 && pr.near < 4)) continue;
      const through = m.runTicks > 0 && this.relX(team, m.x) > rx;
      const lead = through ? 6 + 4 * m.a.spd : 1.2;
      const px = clamp(m.x + this.dir(team) * lead, 1, L - 1);
      const py = clamp(m.y + m.vy * 0.6, 1, W - 1);
      const d = hyp(px - c.x, py - c.y);
      if (d < 4 || d > 50) continue;
      const long = d > 30;
      const p = this.passSuccess(c, px, py, d, long);
      const recvPress = this.nearestOpponentDist(team, px, py);
      let v =
        p * (this.value(team, px, py) * (recvPress < 3 ? 0.85 : 1) + KEEP) -
        (1 - p) * (this.value(team === 0 ? 1 : 0, (c.x + px) / 2, (c.y + py) / 2) + KEEP);
      v += this.rng.normal() * noise;
      if (v > best) {
        best = v;
        action = "pass";
        passTarget = m;
        passKind = long ? "long" : through ? "through" : "pass";
        passPoint = { x: px, y: py };
        passEst = p;
      }
    }

    // cross
    const ry = this.relY(team, c.y);
    if (rx > 0.72 && (ry < 0.24 || ry > 0.76)) {
      let inBox = 0;
      for (const m of this.players)
        if (m.team === team && m.i !== c.i && this.relX(team, m.x) > 0.83 && Math.abs(m.y - CY) < 14) inBox++;
      const v = Math.min(inBox, 3) * 0.022 * (0.6 + 0.5 * c.a.pas) + this.rng.normal() * noise;
      if (inBox > 0 && v > best) {
        best = v;
        action = "cross";
      }
    }

    // clear
    if (rx < 0.28 && pr.near < 2.5) {
      const v = KEEP * 0.3 + this.rng.normal() * noise;
      if (v > best) {
        best = v;
        action = "clear";
      }
    }

    c.decisionCd = Math.round(12 + 10 * (1 - c.a.dec)) + this.rng.int(10);
    this.dbg("act_" + action);
    switch (action) {
      case "shoot":
        this.shoot(c, "open");
        break;
      case "pass":
        this.kickPass(c, passTarget!, passKind, true, passPoint);
        this.flight!.est = passEst;
        break;
      case "cross":
        this.cross(c);
        break;
      case "clear": {
        this.emit("clearance", team, c.i, -1, true, c.x, c.y);
        const tx = this.absX(team, this.rng.range(0.55, 0.8));
        const ty = this.rng.range(8, W - 8);
        this.loft(c, tx, ty, this.rng.range(18, 24));
        this.flight = this.newFlight("clear", team, c.i, -1, tx, ty);
        break;
      }
      default:
        this.dribbleTarget(c, pr.near);
    }
  }

  /** Outfield opponents inside the triangle between (x, y) and the goal posts. */
  coneBlockers(team: number, x: number, y: number): number {
    const gx = this.goalX(team);
    const dx = gx - x;
    const dy = CY - y;
    const d = hyp(dx, dy) || 1;
    let n = 0;
    for (const q of this.players) {
      if (q.team === team || q.role === "GK") continue;
      const along = ((q.x - x) * dx + (q.y - y) * dy) / d;
      if (along < 0.5 || along > d) continue;
      const lat = Math.abs((-(q.x - x) * dy + (q.y - y) * dx) / d);
      if (lat < 0.6 + (along / d) * PITCH.goalHalfW) n++;
    }
    return n;
  }

  private nearestOpponentDist(team: number, x: number, y: number): number {
    let best = 99;
    for (const q of this.players) if (q.team !== team) best = Math.min(best, hyp(q.x - x, q.y - y));
    return best;
  }

  private nearestTeammate(p: Player, filter: (q: Player) => boolean): Player {
    let best: Player | null = null;
    let bd = Infinity;
    for (const q of this.players) {
      if (q.team !== p.team || q.i === p.i || !filter(q)) continue;
      const d = hyp(q.x - p.x, q.y - p.y);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best ?? this.players[p.team * 11 + 5];
  }

  /** Estimated probability a pass reaches its target, from distance, skill and opponents near the lane. */
  passSuccess(c: Player, px: number, py: number, d: number, long: boolean): number {
    const lx = px - c.x;
    const ly = py - c.y;
    let risk = 0;
    for (const q of this.players) {
      if (q.team === c.team) continue;
      let t = ((q.x - c.x) * lx + (q.y - c.y) * ly) / (d * d);
      if (t < 0) continue;
      if (long && t < 0.75) continue;
      t = Math.min(t, 1);
      const lat = hyp(c.x + lx * t - q.x, c.y + ly * t - q.y);
      const cover = 1.3 + t * d * 0.13 + q.a.pos * 0.6;
      if (lat < cover) risk = Math.max(risk, (1 - lat / cover) * (0.55 + 0.25 * q.a.pos));
    }
    const skill = 0.97 - d * (long ? 0.0075 : 0.0045) * (1.5 - c.a.pas);
    return clamp(skill * (1 - risk), 0.02, 0.98);
  }

  private bestPassTarget(c: Player, maxD: number): Player {
    let best: Player | null = null;
    let bv = -Infinity;
    for (const m of this.players) {
      if (m.team !== c.team || m.i === c.i || m.role === "GK") continue;
      const d = hyp(m.x - c.x, m.y - c.y);
      if (d < 5 || d > maxD) continue;
      const p = this.passSuccess(c, m.x, m.y, d, d > 28);
      const v = p * this.value(c.team, m.x, m.y) + this.rng.next() * 0.002;
      if (v > bv) {
        bv = v;
        best = m;
      }
    }
    return best ?? this.nearestTeammate(c, () => true);
  }

  private newFlight(kind: FlightKind, team: 0 | 1, from: number, to: number, tx: number, ty: number): Flight {
    return {
      kind,
      team,
      from,
      to,
      tx,
      ty,
      onTarget: false,
      blockAt: 0,
      blocker: -1,
      traveled: 0,
      saveAtX: 0,
      saveOutcome: 0,
      header: false,
      est: -1,
      ox: this.bx,
      oy: this.by,
    };
  }

  private releaseBall(c: Player) {
    this.owner = -1;
    this.gkHold = 0;
    this.lastTeam = c.team;
    this.lastPlayer = c.i;
    c.touchCd = 7;
    this.bx = c.x + c.fx * 0.5;
    this.by = c.y + c.fy * 0.5;
    this.pbx = this.bx;
    this.pby = this.by;
    this.pbz = 0;
  }

  private kickPass(c: Player, m: Player, kind: FlightKind, pressure: boolean, point?: { x: number; y: number }) {
    const px = point ? point.x : m.x;
    const py = point ? point.y : m.y;
    let dx = px - c.x;
    let dy = py - c.y;
    const d = hyp(dx, dy) || 1;
    const pr = pressure ? this.pressureOn(c).count : 0;
    const err = (0.03 + d * 0.022) * (1.2 - c.a.pas) * (1 + 0.5 * pr) * (kind === "throw" ? 0.6 : 1);
    const lat = this.rng.normal() * err;
    const lon = this.rng.normal() * err * 0.8;
    const ux = dx / d;
    const uy = dy / d;
    const ax = px + -uy * lat + ux * lon;
    const ay = py + ux * lat + uy * lon;
    this.releaseBall(c);
    dx = ax - this.bx;
    dy = ay - this.by;
    const ad = hyp(dx, dy) || 1;
    if (kind === "long") {
      this.loft(c, ax, ay, clamp(12 + ad * 0.22, 14, 24));
    } else {
      const vEnd = kind === "through" ? 6 : kind === "throw" ? 4 : 4.5;
      const v0 = Math.sqrt(vEnd * vEnd + 2 * ROLL_DECEL * ad);
      this.bvx = (dx / ad) * v0;
      this.bvy = (dy / ad) * v0;
      this.bvz = kind === "throw" ? 3 : 0;
      if (kind === "throw") this.bz = 1.8;
    }
    this.flight = this.newFlight(kind, c.team, c.i, m.i, ax, ay);
  }

  /** A lofted ball that lands on (tx, ty) after travelling at horizontal speed vh. */
  private loft(c: Player, tx: number, ty: number, vh: number) {
    if (this.owner === c.i) this.releaseBall(c);
    const dx = tx - this.bx;
    const dy = ty - this.by;
    const d = hyp(dx, dy) || 1;
    const t = d / vh;
    this.bvx = (dx / d) * vh;
    this.bvy = (dy / d) * vh;
    this.bvz = (G * t) / 2;
    this.bz = 0.01;
  }

  private cross(c: Player) {
    const team = c.team;
    const gx = this.goalX(team);
    // aim at the best-placed attacker in the box, or the penalty spot area
    let target: Player | null = null;
    let bv = -Infinity;
    for (const m of this.players) {
      if (m.team !== team || m.i === c.i || m.role === "GK") continue;
      if (this.relX(team, m.x) < 0.8 || Math.abs(m.y - CY) > 15) continue;
      const v = m.a.pos + m.a.fin - this.nearestOpponentDist(team, m.x, m.y) * -0.05 + this.rng.next() * 0.3;
      if (v > bv) {
        bv = v;
        target = m;
      }
    }
    const tx = target ? target.x : gx - this.dir(team) * this.rng.range(6, 12);
    const ty = target ? target.y : CY + this.rng.range(-6, 6);
    const err = 2.5 * (1.25 - c.a.pas);
    const ax = tx + this.rng.normal() * err;
    const ay = ty + this.rng.normal() * err;
    this.releaseBall(c);
    this.loft(c, ax, ay, this.rng.range(17, 22));
    this.flight = this.newFlight("cross", team, c.i, target ? target.i : -1, ax, ay);
  }

  private shoot(c: Player, kind: "open" | "header" | "free_kick" | "penalty") {
    const team = c.team;
    const gx = this.goalX(team);
    const d = hyp(gx - c.x, CY - c.y);
    const pp = this.pressureOn(c);
    const pr = kind === "open" || kind === "header" ? pp.count + (pp.near < 1.5 ? 1.5 : pp.near < 3 ? 0.7 : 0) : 0;
    const side = this.rng.chance(0.5) ? -1 : 1;
    const margin = clamp(0.35 + (1 - c.a.fin) * 1.6 + this.rng.next() * 0.9, 0.3, 3.4);
    const aimY = CY + side * (PITCH.goalHalfW - margin);
    const sigma =
      (1.2 + d * 0.18) * (1.45 - c.a.fin) * (1 + 0.45 * pr) * (kind === "header" ? 1.6 : kind === "penalty" ? 0.45 : 1);
    const yAt = aimY + this.rng.normal() * sigma;
    const hAt = clamp(0.35 + this.rng.next() * 1.5 + this.rng.normal() * sigma * 0.45, -0.5, 5);
    const v = kind === "header" ? 10 + 6 * c.a.fin : kind === "penalty" ? 21 + 6 * c.a.sho : 17 + 12 * c.a.sho;

    if (this.owner === c.i) this.releaseBall(c);
    else {
      this.lastTeam = team;
      this.lastPlayer = c.i;
      this.pbx = this.bx;
      this.pby = this.by;
      this.pbz = this.bz;
    }
    const z0 = kind === "header" ? Math.max(this.bz, 1.8) : 0.11;
    const dx = gx - this.bx;
    const dy = yAt - this.by;
    const dd = hyp(dx, dy) || 1;
    const t = dd / v;
    this.bz = z0;
    this.bvx = (dx / dd) * v;
    this.bvy = (dy / dd) * v;
    this.bvz = (hAt - z0 + 0.5 * G * t * t) / t;

    // where and how high the ball would cross the goal line, using the same integrator as the live ball
    const b = { x: this.bx, y: this.by, z: this.bz, vx: this.bvx, vy: this.bvy, vz: this.bvz };
    let yc = b.y;
    let zc = b.z;
    let travel = 0;
    for (let k = 0; k < 120; k++) {
      const px = b.x;
      const py = b.y;
      const pz = b.z;
      Simulation.integrate(b);
      travel += hyp(b.x - px, b.y - py);
      if ((gx > 0 && b.x >= gx) || (gx === 0 && b.x <= 0)) {
        const f = (gx - px) / (b.x - px || 1e-9);
        yc = py + f * (b.y - py);
        zc = pz + f * (b.z - pz);
        break;
      }
      if (hyp(b.vx, b.vy) < 1) {
        yc = -99;
        break;
      }
    }
    const onTarget = yc > GOAL_Y0 && yc < GOAL_Y1 && zc < PITCH.goalH;
    const f = this.newFlight("shot", team, c.i, -1, gx, yc);
    f.onTarget = onTarget;
    f.header = kind === "header";
    this.emit("shot", team, c.i, -1, onTarget, c.x, c.y);
    this.dbg("shot_" + kind);
    this.dbg("shotd_" + Math.min(40, Math.floor(d / 5) * 5));

    // blocks: the first defender close to the line of the shot who gets a body on it
    if (kind !== "penalty") {
      const ux = dx / dd;
      const uy = dy / dd;
      let bestT = Infinity;
      for (const q of this.players) {
        if (q.team === team || q.role === "GK") continue;
        const along = (q.x - this.bx) * ux + (q.y - this.by) * uy;
        if (along < 1 || along > Math.min(dd, travel) - 1) continue;
        const lat = Math.abs(-(q.x - this.bx) * uy + (q.y - this.by) * ux);
        const reach = 0.7 + 0.4 * q.a.mrk;
        if (lat > reach) continue;
        if (along < bestT && this.rng.chance(0.42 * (1 - lat / reach) + 0.18 * q.a.mrk)) {
          bestT = along;
          f.blocker = q.i;
          f.blockAt = along;
        }
      }
    }

    // the goalkeeper
    if (onTarget && f.blocker < 0) {
      const gk = this.gkOf(team === 0 ? 1 : 0);
      const cover = Math.min(3, (2.5 + 2 * gk.a.spd) * Math.max(0, t - 0.2) * 0.7);
      const lat = Math.max(0, Math.abs(gk.y - yc) - cover);
      const reach = 1.6 + 2.0 * gk.a.gk;
      let save: number;
      if (kind === "penalty") save = clamp(0.12 + 0.22 * gk.a.gk - 0.12 * c.a.fin + 0.06, 0.08, 0.35);
      else if (lat > reach) save = 0.35;
      else
        save = clamp(
          0.9 +
            0.3 * gk.a.gk -
            (v - 18) * 0.012 -
            (lat / reach) * 0.3 +
            Math.max(0, d - 12) * 0.025 +
            (zc > 1.9 ? -0.05 : 0) +
            (kind === "header" ? 0.1 : 0),
          0.05,
          0.96,
        );
      this.dbg(lat > reach ? "gk_outofreach" : "gk_inreach");
      this.dbg("gk_p" + Math.floor(save * 10));
      if (this.rng.chance(save)) {
        f.saveOutcome = this.rng.chance(v < 21 ? 0.55 : 0.3) ? 1 : 2;
        const gx0 = this.ownGoalX(gk.team);
        f.saveAtX = gx0 === 0 ? Math.max(gk.x, 0.4) : Math.min(gk.x, L - 0.4);
      }
    }
    this.flight = f;
  }

  // ---------------------------------------------------------------- off-ball movement

  private secondLastDefenderRel(team: number): number {
    // in `team`'s attacking frame: the deepest-but-one opponent
    let a = 0;
    let b = 0;
    for (const q of this.players) {
      if (q.team === team) continue;
      const r = this.relX(team, q.x);
      if (r > a) {
        b = a;
        a = r;
      } else if (r > b) b = r;
    }
    return b;
  }

  private computeTargets(bx: number, by: number, possTeam: number, dead: boolean) {
    const loose =
      !dead &&
      this.owner < 0 &&
      (!this.flight || this.flight.kind === "loose" || this.flight.kind === "clear" || this.flight.kind === "shot");
    const restart = dead ? this.restart : null;
    for (let t = 0; t < 2; t++) {
      const inPoss = possTeam === t;
      const defending = possTeam >= 0 && !inPoss;
      const brx = this.relX(t, bx);
      const bry = this.relY(t, by);
      const offside = Math.max(0.5, this.secondLastDefenderRel(t), brx) - 0.008;
      const marks = defending && !dead ? this.assignMarks(t) : null;
      for (let k = 0; k < 11; k++) {
        const p = this.players[t * 11 + k];
        if (p.i === this.owner) continue;
        p.sprint = false;
        if (p.role === "GK") {
          this.gkTarget(p, bx, by);
          continue;
        }
        const roleShift = p.role === "DEF" ? 0.5 : p.role === "MID" ? 0.62 : 0.55;
        let rx = p.slot.rx + (brx - 0.42) * roleShift + (inPoss ? 0.07 : defending ? -0.07 : 0);
        let ry = p.slot.ry + (bry - 0.5) * (defending ? 0.42 : 0.3);
        if (defending) ry = 0.5 + (ry - 0.5) * 0.85;
        if (inPoss && p.slot.wide) ry = 0.5 + (ry - 0.5) * 1.18;
        if (p.role === "DEF") rx = Math.min(rx, inPoss ? 0.62 : 0.5);
        if (defending) {
          // two compact, narrow lines between the ball and the goal; forwards stay up for the counter
          const line = clamp(brx - 0.2, 0.07, 0.36);
          if (p.role === "DEF") {
            rx = line + (p.slot.rx - 0.19) * 0.5;
            ry = 0.5 + (p.slot.ry - 0.5) * 0.7 + (bry - 0.5) * 0.3;
          } else if (p.role === "MID") {
            rx = clamp(line + 0.13 + (p.slot.rx - 0.36) * 0.5, 0.14, 0.62);
            ry = 0.5 + (p.slot.ry - 0.5) * 0.78 + (bry - 0.5) * 0.36;
          } else {
            rx = clamp(line + 0.3 + (p.slot.rx - 0.57) * 0.5, 0.32, 0.72);
          }
        }
        if (inPoss && p.role !== "DEF") {
          if (
            p.runTicks === 0 &&
            (p.role === "FWD" || p.slot.rx > 0.44) &&
            brx > 0.35 &&
            this.rng.chance(0.004 + 0.004 * p.a.pos)
          ) {
            p.runTicks = 25 + this.rng.int(20);
          }
          if (p.runTicks > 0) {
            rx = offside;
            ry = 0.5 + (ry - 0.5) * 0.6;
            p.sprint = true;
          }
        }
        if (inPoss) rx = Math.min(rx, offside);
        rx = clamp(rx, 0.03, 0.97);
        ry = clamp(ry, 0.03, 0.97);
        let x = this.absX(t, rx);
        let y = this.absY(t, ry);

        if (defending && !dead) {
          // mark the nearest opponent to this zone, staying goal-side
          // near the own box everyone goes tight, man to man
          const danger = brx < 0.36;
          let mark: Player | null = null;
          const mi = marks![k];
          if (mi >= 0) {
            const q = this.players[mi];
            const md = danger ? 16 : p.role === "DEF" ? 9 : 12;
            if (hyp(q.x - x, q.y - y) < md) mark = q;
          }
          if (mark) {
            const gx = this.ownGoalX(t);
            // anticipate where the runner is going
            const mx = mark.x + mark.vx * 0.6;
            const my = mark.y + mark.vy * 0.6;
            const vx = gx - mx;
            const vy = CY - my;
            const n = hyp(vx, vy) || 1;
            const w = danger ? 0.7 + 0.25 * p.a.mrk : 0.3 + 0.35 * p.a.mrk;
            const gap = danger ? 1.3 : 2.6;
            x = x * (1 - w) + (mx + (vx / n) * gap) * w;
            y = y * (1 - w) + (my + (vy / n) * gap) * w;
            if (danger || hyp(mark.vx, mark.vy) > 5) p.sprint = true;
          }
        }
        if (restart) {
          // keep the distance at set pieces
          if (t !== restart.team && restart.type !== "throw_in") {
            const dx = x - restart.x;
            const dy = y - restart.y;
            const d = hyp(dx, dy);
            if (d < FREE_KICK_DISTANCE + 0.5) {
              const n = d || 1;
              x = restart.x + (dx / n) * (FREE_KICK_DISTANCE + 0.5);
              y = restart.y + (dy / n) * (FREE_KICK_DISTANCE + 0.5);
            }
          }
          if (restart.type === "corner") {
            const gx = this.goalX(restart.team);
            const attacking = t === restart.team;
            if (
              attacking &&
              (p.role === "FWD" || (p.role === "DEF" && k % 2 === 0) || (p.role === "MID" && k % 3 === 0))
            ) {
              x = gx - this.dir(t) * (6 + ((k * 3) % 7));
              y = CY + (((k * 5) % 13) - 6);
            } else if (!attacking) {
              const ogx = this.ownGoalX(t);
              x = ogx + this.dir(t) * (5 + ((k * 2) % 9));
              y = CY + (((k * 7) % 17) - 8);
            }
          }
          if (restart.type === "penalty") {
            const gx = restart.x;
            if (Math.abs(x - gx) < 12 && Math.abs(y - CY) < PITCH.boxHalfW + 1) {
              x = gx - (gx > L / 2 ? 1 : -1) * 0 + (gx > L / 2 ? -12 : 12);
            }
          }
          if (restart.type === "kickoff") {
            const own = this.dir(t) > 0 ? Math.min(x, L / 2 - 1) : Math.max(x, L / 2 + 1);
            x = own;
          }
        }
        p.tx = clamp(x, 0.5, L - 0.5);
        p.ty = clamp(y, 0.5, W - 0.5);
        if (hyp(p.tx - p.x, p.ty - p.y) > 9) p.sprint = true;
      }
    }
    if (dead) return;

    const f = this.flight;
    if (this.owner >= 0) {
      // press the ball carrier: closest defender engages, second covers
      const c = this.players[this.owner];
      const opp = c.team === 0 ? 1 : 0;
      let first: Player | null = null;
      let second: Player | null = null;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let k = 1; k < 11; k++) {
        const q = this.players[opp * 11 + k];
        const d = hyp(q.x - c.x, q.y - c.y);
        if (d < d1) {
          second = first;
          d2 = d1;
          first = q;
          d1 = d;
        } else if (d < d2) {
          second = q;
          d2 = d;
        }
      }
      if (first && this.gkHold === 0) {
        // engage goal-side and jockey; close right in only near the own goal
        const gx = this.ownGoalX(opp);
        const vx = gx - c.x;
        const vy = CY - c.y;
        const n = hyp(vx, vy) || 1;
        const gap = this.relX(opp, c.x) < 0.3 ? 0.8 : 2.2 - first.a.tck;
        first.tx = c.x + c.vx * 0.3 + (vx / n) * gap;
        first.ty = c.y + c.vy * 0.3 + (vy / n) * gap;
        first.sprint = d1 < 25;
      }
      if (second && this.gkHold === 0) {
        const gx = this.ownGoalX(opp);
        const vx = gx - c.x;
        const vy = CY - c.y;
        const n = hyp(vx, vy) || 1;
        second.tx = c.x + (vx / n) * 6;
        second.ty = c.y + (vy / n) * 6;
        second.sprint = d2 < 20;
      }
      // the two nearest teammates offer support
      let s1: Player | null = null;
      let s2: Player | null = null;
      let e1 = Infinity;
      let e2 = Infinity;
      for (let k = 1; k < 11; k++) {
        const q = this.players[c.team * 11 + k];
        if (q.i === c.i || q.runTicks > 0) continue;
        const d = hyp(q.x - c.x, q.y - c.y);
        if (d < e1) {
          s2 = s1;
          e2 = e1;
          s1 = q;
          e1 = d;
        } else if (d < e2) {
          s2 = q;
          e2 = d;
        }
      }
      for (const s of [s1, s2]) {
        if (!s) continue;
        const ox = s.tx - c.x;
        const oy = s.ty - c.y;
        const n = hyp(ox, oy) || 1;
        const want = 11 + 3 * s.a.pos;
        s.tx = clamp(c.x + (ox / n) * want, 1, L - 1);
        s.ty = clamp(c.y + (oy / n) * want, 1, W - 1);
      }
    } else if (
      f &&
      (f.kind === "pass" || f.kind === "through" || f.kind === "long" || f.kind === "throw" || f.kind === "cross") &&
      f.to >= 0
    ) {
      const r = this.players[f.to];
      // come to meet the ball rather than wait for it
      const vx = this.bx - f.tx;
      const vy = this.by - f.ty;
      const n = hyp(vx, vy) || 1;
      const meet = f.kind === "long" || f.kind === "cross" ? 0 : Math.min(2, n * 0.2);
      r.tx = f.tx + (vx / n) * meet;
      r.ty = f.ty + (vy / n) * meet;
      r.sprint = true;
      this.chaseBall(f.team === 0 ? 1 : 0, f.tx, f.ty, 1);
    }
    if (loose || (f && f.to < 0)) {
      const sp = hyp(this.bvx, this.bvy);
      const lead = Math.min(1.2, sp * 0.08);
      const px = this.bx + this.bvx * lead;
      const py = this.by + this.bvy * lead;
      this.chaseBall(0, px, py, 1);
      this.chaseBall(1, px, py, 1);
    }
  }

  /**
   * One-to-one marking: the opponents nearest our goal are picked up first, each by the closest free outfielder.
   * Returns, per slot of `team`, the global index of the opponent marked (-1 = zonal).
   */
  private assignMarks(team: number): number[] {
    const out = new Array<number>(11).fill(-1);
    const gx = this.ownGoalX(team);
    const threats: Player[] = [];
    for (const q of this.players) if (q.team !== team && q.role !== "GK" && q.i !== this.owner) threats.push(q);
    threats.sort((a, b) => hyp(a.x - gx, a.y - CY) - hyp(b.x - gx, b.y - CY) || a.i - b.i);
    const taken = new Array<boolean>(11).fill(false);
    taken[0] = true;
    for (const q of threats) {
      let best = -1;
      let bd = Infinity;
      for (let k = 1; k < 11; k++) {
        if (taken[k]) continue;
        const p = this.players[team * 11 + k];
        if (p.role === "FWD") continue;
        const d = hyp(p.x - q.x, p.y - q.y);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best < 0) break;
      taken[best] = true;
      out[best] = q.i;
    }
    return out;
  }

  private chaseBall(team: number, px: number, py: number, n: number) {
    let best: Player | null = null;
    let bt = Infinity;
    for (let k = 0; k < 11; k++) {
      const q = this.players[team * 11 + k];
      if (q.role === "GK" && (!this.inOwnBox(team, px, py) || this.bz > 1.6)) continue;
      const t = hyp(q.x - px, q.y - py) / (6 + 3 * q.a.spd);
      if (t < bt) {
        bt = t;
        best = q;
      }
    }
    if (best && n > 0) {
      best.tx = clamp(px, -0.5, L + 0.5);
      best.ty = clamp(py, -0.5, W + 0.5);
      best.sprint = true;
    }
  }

  private gkTarget(p: Player, bx: number, by: number) {
    const gx = this.ownGoalX(p.team);
    if (this.owner >= 0 && this.state === "play") {
      const c = this.players[this.owner];
      if (c.team !== p.team && Math.abs(c.x - gx) < 15 && Math.abs(c.y - CY) < 14) {
        // come off the line to close the angle and smother
        const vx = gx - c.x;
        const vy = CY - c.y;
        const n = hyp(vx, vy) || 1;
        const stay = Math.max(0.8, n * (0.55 - 0.25 * p.a.pos));
        p.tx = c.x + (vx / n) * stay;
        p.ty = c.y + (vy / n) * stay;
        p.sprint = true;
        return;
      }
    }
    const d = hyp(bx - gx, by - CY);
    const close = clamp(1 - d / 40, 0, 1);
    const out = 0.8 + 4.2 * close * (0.6 + 0.4 * p.a.pos);
    p.tx = gx + this.dir(p.team) * out;
    p.ty = CY + clamp((by - CY) * (0.12 + 0.18 * close), -PITCH.goalHalfW + 0.4, PITCH.goalHalfW - 0.4);
    p.sprint = close > 0.6;
  }

  private movePlayers(carrier: number) {
    for (const p of this.players) {
      const top = (5.4 + 3.6 * p.a.spd) * (0.78 + 0.22 * p.stamina);
      let vmax = p.sprint ? top : top * 0.55;
      if (p.i === carrier) vmax = top * (0.72 + 0.16 * p.a.dri) * (p.sprint ? 1 : 0.8);
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = hyp(dx, dy);
      let wx = 0;
      let wy = 0;
      if (d > 0.15) {
        const s = Math.min(vmax, d * 1.3);
        wx = (dx / d) * s;
        wy = (dy / d) * s;
      }
      let ax = wx - p.vx;
      let ay = wy - p.vy;
      const am = hyp(ax, ay);
      const maxA = (3.2 + 4 * p.a.acc) * DT;
      if (am > maxA) {
        ax = (ax / am) * maxA;
        ay = (ay / am) * maxA;
      }
      p.vx += ax;
      p.vy += ay;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      const sp = hyp(p.vx, p.vy);
      if (sp > 0.3) {
        p.fx = p.vx / sp;
        p.fy = p.vy / sp;
      }
      const ratio = sp / top;
      if (ratio > 0.7) p.stamina = Math.max(0.2, p.stamina - (ratio - 0.7) * 0.00045 * (1.35 - p.a.sta));
      else p.stamina = Math.min(1, p.stamina + 0.00003);
      if (p.i === carrier) {
        p.x = clamp(p.x, 0.4, L - 0.4);
        p.y = clamp(p.y, 0.4, W - 0.4);
      } else {
        p.x = clamp(p.x, -2, L + 2);
        p.y = clamp(p.y, -2, W + 2);
      }
    }
    // light separation between all players
    for (let a = 0; a < 22; a++) {
      const p = this.players[a];
      for (let b = a + 1; b < 22; b++) {
        const q = this.players[b];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        if (dx > 1.1 || dx < -1.1 || dy > 1.1 || dy < -1.1) continue;
        const d = hyp(dx, dy);
        if (d < 1.1 && d > 1e-6) {
          const push = (1.1 - d) * 0.25;
          const ux = (dx / d) * push;
          const uy = (dy / d) * push;
          if (p.i !== carrier) {
            p.x -= ux;
            p.y -= uy;
          }
          if (q.i !== carrier) {
            q.x += ux;
            q.y += uy;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- output

  result(): MatchResult {
    const stats = deriveStats(this.events, this.possTicks);
    return {
      config: this.config,
      seed: this.seed,
      homeGoals: this.score[0],
      awayGoals: this.score[1],
      firstScorer: this.firstScorer === 0 ? "home" : this.firstScorer === 1 ? "away" : "none",
      stats,
      possessionTicks: [this.possTicks[0], this.possTicks[1]],
      events: this.events,
      frames: this.frames,
      owners: this.owners,
    };
  }
}

const emptyStats = (): TeamStats => ({
  goals: 0,
  shots: 0,
  shotsOnTarget: 0,
  corners: 0,
  fouls: 0,
  saves: 0,
  passes: 0,
  passesCompleted: 0,
  tackles: 0,
  interceptions: 0,
  possession: 0,
});

/** Every statistic is counted from the event log (possession from ticks), so stats can never disagree with play. */
export function deriveStats(
  events: readonly MatchEvent[],
  possTicks: readonly [number, number],
): [TeamStats, TeamStats] {
  const s: [TeamStats, TeamStats] = [emptyStats(), emptyStats()];
  for (const e of events) {
    if (e.team === -1) continue;
    const t = s[e.team];
    switch (e.type) {
      case "goal":
        t.goals++;
        break;
      case "shot":
        t.shots++;
        if (e.ok) t.shotsOnTarget++;
        break;
      case "corner":
        t.corners++;
        break;
      case "foul":
        t.fouls++;
        break;
      case "save":
        t.saves++;
        break;
      case "pass":
      case "cross":
        t.passes++;
        if (e.ok) t.passesCompleted++;
        break;
      case "tackle":
        if (e.ok) t.tackles++;
        break;
      case "interception":
        t.interceptions++;
        break;
    }
  }
  const total = possTicks[0] + possTicks[1];
  s[0].possession = total ? Math.round((possTicks[0] / total) * 1000) / 10 : 50;
  s[1].possession = total ? Math.round(1000 - s[0].possession * 10) / 10 : 50;
  return s;
}
