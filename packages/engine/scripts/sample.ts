import { buildConfig, simulate, keccakHex, TEAMS } from "../src/index";
const n = Number(process.argv[2] ?? 10);
const tot = { g: 0, sh: 0, sot: 0, pa: 0, pc: 0, co: 0, fo: 0, sv: 0, tk: 0, int: 0, homeW: 0, draw: 0, awayW: 0 };
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const h = i % TEAMS.length,
    a = (i * 7 + 3) % TEAMS.length;
  const cfg = buildConfig(BigInt(i + 1), h, a === h ? (a + 1) % 20 : a);
  const r = simulate(cfg, keccakHex("seed" + i));
  const [s0, s1] = r.stats;
  tot.g += r.homeGoals + r.awayGoals;
  tot.sh += s0.shots + s1.shots;
  tot.sot += s0.shotsOnTarget + s1.shotsOnTarget;
  tot.pa += s0.passes + s1.passes;
  tot.pc += s0.passesCompleted + s1.passesCompleted;
  tot.co += s0.corners + s1.corners;
  tot.fo += s0.fouls + s1.fouls;
  tot.sv += s0.saves + s1.saves;
  tot.tk += s0.tackles + s1.tackles;
  tot.int += s0.interceptions + s1.interceptions;
  if (r.homeGoals > r.awayGoals) tot.homeW++;
  else if (r.homeGoals === r.awayGoals) tot.draw++;
  else tot.awayW++;
  if (i < 5)
    console.log(
      cfg.home.short,
      r.homeGoals,
      "-",
      r.awayGoals,
      cfg.away.short,
      "poss",
      s0.possession,
      "shots",
      s0.shots,
      s1.shots,
      "passes",
      s0.passes,
      s1.passes,
    );
}
const ms = (performance.now() - t0) / n;
const per = (k: keyof typeof tot) => (tot[k] / n).toFixed(1);
console.log(
  `per match: goals ${per("g")} shots ${per("sh")} onT ${per("sot")} passes ${per("pa")} acc ${((tot.pc / tot.pa) * 100).toFixed(0)}% corners ${per("co")} fouls ${per("fo")} saves ${per("sv")} tackles ${per("tk")} int ${per("int")} | H/D/A ${tot.homeW}/${tot.draw}/${tot.awayW} | ${ms.toFixed(0)} ms/match`,
);
