import { buildConfig, simulate, keccakHex, TEAMS } from "../src/index";
const pairs = [
  [0, 19],
  [19, 0],
  [0, 1],
  [5, 12],
];
for (const [h, a] of pairs) {
  let w = 0,
    d = 0,
    l = 0,
    gh = 0,
    ga = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    const r = simulate(buildConfig(BigInt(i), h, a), keccakHex(`s${h}-${a}-${i}`));
    gh += r.homeGoals;
    ga += r.awayGoals;
    if (r.homeGoals > r.awayGoals) w++;
    else if (r.homeGoals === r.awayGoals) d++;
    else l++;
  }
  console.log(
    `${TEAMS[h].short}(${TEAMS[h].rating}) v ${TEAMS[a].short}(${TEAMS[a].rating}): W${w} D${d} L${l} goals ${(gh / n).toFixed(2)}-${(ga / n).toFixed(2)}`,
  );
}
