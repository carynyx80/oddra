# Match engine rules (`oddra-sim/1.0.0`)

Source: [packages/engine/src/sim.ts](../packages/engine/src/sim.ts). A match is 54,000 steps of 0.1 game seconds
(two halves of 27,000), played back over 15 real minutes (6× speed). Positions are recorded every 5 steps.

## Inputs

- **Config**: match id, both clubs (formation, 11 players × 13 attributes from 1 to 99), `ENGINE_VERSION`.
- **Seed**: 32 bytes, folded into the four words of an sfc32 PRNG. Every random draw is consumed in a fixed order.

## Players and movement

- Four formations (4-3-3, 4-4-2, 4-2-3-1, 3-5-2), each a set of slots in team-relative coordinates; sides swap at
  half-time.
- Off the ball, every outfielder targets its slot shifted with the ball. In possession: width, support angles from
  the two nearest team-mates, attacking runs (started more often by players with high positioning) that hold the
  offside line. Out of possession: two compact, narrow lines between ball and goal, one-to-one marking assigned
  nearest-threat-first, tighter and goal-side near the box; the nearest player engages the carrier, the next covers.
- Movement is steered toward the target with acceleration and top speed from the attributes; sprinting drains stamina,
  which lowers top speed. Players separate softly when closer than 1.1 m.
- Goalkeepers hold a line between ball and goal centre, come off it to close down a carrier in the box, smother, and
  collect loose balls in their area (with hands except from a team-mate's pass).

## Ball

- 2-D position plus height. Rolling deceleration 2.6 m/s²; lofted balls follow gravity, bounce (vertical ×0.4,
  horizontal ×0.62) and slow with light drag.
- Out of play: touchline → throw-in to the other side of the last touch; goal line → goal if between the posts and
  under the bar (interpolated crossing point), otherwise goal kick or corner by last touch.

## Decisions (ball carrier)

Every 0.8–2.6 s (faster under pressure, shorter for better decision-making) the carrier scores each option and picks
the best, with noise that shrinks as decision-making improves:

- **Shoot**: expected-goal model from distance and angle, discounted for pressure and for every defender in the
  shooting cone.
- **Pass** to each team-mate (ground, through ball for runners, long lofted ball): success estimated from distance,
  passing and the opponents near the lane; value = position value at the receiver vs. losing the ball.
- **Dribble** forward (further into open space), **cross** from wide areas into the box, **clear** under pressure.
  A constant "keep the ball" value makes risky passes and speculative shots costly.

## Contests

- **Reception / interception**: players within reach of the ball's path this step may control it; the intended
  receiver is favoured, opponents need tackling/positioning, fast balls are harder. Misses may deflect the ball.
- **Tackles**: within 1.5 m; success from tackling vs. dribbling/control; a failed tackle may be a foul (free kick, or
  penalty in the box).
- **Headers**: aerial balls are contested; attackers in the box head at goal, defenders clear (sometimes behind for a
  corner).
- **Shots**: aim inside the posts, error from distance, finishing and pressure; defenders in line may block; the
  keeper's save chance comes from goalkeeping, reach, shot speed, distance and height. Saves are caught or parried
  (often round the post).

## Set pieces

Kick-off, throw-in, goal kick, corner (crowded box, cross), free kick (direct shot when close and central, otherwise
cross or pass), penalty (keeper vs. finisher). Dead-ball time is realistic (e.g. 13 s for a throw, 26 s for a corner).

## Outputs

Event log (`seq`, `tick`, type, players, outcome, position, score), statistics counted only from the events
(possession from ticks), the frames, and keccak hashes of all of it. Measured over 60 matches: 2.6 goals,
20.5 shots, 7.8 on target, 6.3 saves, 18.5 fouls, 2.5 corners, 85% pass accuracy per match; stronger clubs win more often.

Known simplifications: no offside calls (runners never start offside), no cards or substitutions, no stoppage time,
passes per match (≈1,700) and corners (≈2.5) differ from real football (≈1,000 and ≈10).
