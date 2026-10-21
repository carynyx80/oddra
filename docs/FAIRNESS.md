# Fairness model

The question this answers: **can the operator choose a match result after seeing the bets?**

## Commit, then entropy, then reveal

| Step             | When                                                                                | What becomes fixed                                                                                                                  | Who acts |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. `createMatch` | Before the betting window opens (the contract rejects `openTime < block.timestamp`) | `configHash` (teams, every player attribute, formations, engine ruleset) and `seedCommit = keccak256(serverSeed)`                   | Operator |
| 2. Betting       | `openTime ≤ t < kickoff`, enforced by block timestamp                               | Each bet's selection, stake and exact odds                                                                                          | Bettors  |
| 3. `lock`        | Any time after kickoff                                                              | `entropyBlock = ArbSys.arbBlockNumber() + 4`, an L2 block that does not exist yet                                                   | Anyone   |
| 4. `reveal`      | After `entropyBlock`, within 256 blocks                                             | `entropy = arbBlockHash(entropyBlock)`, `finalSeed = keccak256(serverSeed ‖ entropy ‖ matchId)`; the seed must match the commitment | Operator |
| 5. Replay        | Immediately                                                                         | The whole match (every position, event and statistic) is a pure function of `(config, finalSeed)`                                   | Anyone   |
| 6. `settle`      | After `kickoff + 900 s`                                                             | Score, first scorer and `resultHash` (binds score, stats, event log and every frame)                                                | Operator |

The server seed is committed before any bet exists, and the entropy is the hash of a block produced after betting has
closed, so at the moment the operator commits, the outcome is unknowable to everyone, including the operator. On
Robinhood Chain (Arbitrum Orbit) `block.number` is the L1 block and `blockhash` is not an L2 hash, so the registry
reads the ArbSys precompile at `0x64` instead.

Every viewer re-derives `finalSeed` and replays the match in their own browser; the match page shows each check
(`/matches/<id>` → Verification), and `resultHash` lets anyone confirm that the animation, statistics and settlement
are the same simulation.

## Trust assumptions (read these before using real money)

1. **The engine runs off-chain.** The registry checks the seed but cannot re-run 54,000 simulation steps, so it
   accepts the operator's posted score. A wrong score is _publicly provable_ (anyone can replay it) but _not rejected
   on-chain_. Closing this gap needs an on-chain verifier, a validity proof (zkVM) of the engine, or an optimistic
   challenge game with bonded operators. Until one exists, real-money settlement must stay disabled.
2. **Withholding.** Once the entropy block exists, the operator can compute the result before revealing. If it never
   reveals (or never settles), anyone can void the match after the deadline and every stake is refunded. Refunds cost
   the operator nothing, so withholding is a free option on bad outcomes; a production version should bond the
   operator and slash it on a missed reveal.
3. **Sequencer.** Entropy is an L2 block hash produced by Robinhood Chain's sequencer. A sequencer colluding with the
   operator could grind block hashes. No verifiable randomness service (Chainlink VRF, Pyth Entropy, Gelato VRF) could
   be confirmed on Robinhood Chain when this was built; switch to one as soon as it is available.
4. **Pricing.** Odds come from simulating the fixture with pricing-only seeds. They are published before bets are
   accepted and stored per bet; no later change touches an accepted bet.
5. **Determinism across platforms.** The engine uses only `+ − × ÷ √`, `abs/min/max/floor/round` and a 32-bit integer
   PRNG, all of which IEEE-754 and the JavaScript spec make bit-exact. Any change to engine code, constants or team
   data requires a new `ENGINE_VERSION`, which changes `rulesetHash` and the committed config.

## Reproducing a match yourself

```ts
import { buildConfig, configHash, finalSeed, resultHash, simulate } from "@oddra/engine";
// read getMatch(id) from OddraMatchRegistry
const cfg = buildConfig(id, m.homeTeam, m.awayTeam);
console.assert(configHash(cfg) === m.configHash);
console.assert(finalSeed(m.serverSeed, m.entropy, id) === m.finalSeed);
const r = simulate(cfg, m.finalSeed);
console.assert(resultHash(r) === m.resultHash);
```
