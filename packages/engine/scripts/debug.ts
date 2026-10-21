import { buildConfig, keccakHex, Simulation } from "../src/index";
const n = Number(process.argv[2] ?? 5);
const agg: Record<string, number> = {};
for (let i = 0; i < n; i++) {
  const s = new Simulation(buildConfig(BigInt(i + 1), i % 20, (i + 5) % 20), keccakHex("d" + i));
  const r = s.run();
  for (const [k, v] of Object.entries(s.debug)) agg[k] = (agg[k] ?? 0) + v;
  const goals = r.events.filter((e) => e.type === "goal");
  if (i === 0)
    console.log(
      goals
        .slice(0, 8)
        .map((g) => `${Math.floor(g.tick / 600)}' t${g.team} p${g.player}`)
        .join(" "),
    );
}
for (const k of Object.keys(agg).sort()) console.log(k.padEnd(28), (agg[k] / n).toFixed(1));
