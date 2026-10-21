import type { MatchConfig, MatchEvent } from "@oddra/engine";

const pick = (seq: number, options: string[]) => options[seq % options.length];

export function playerName(cfg: MatchConfig, index: number): string {
  if (index < 0) return "";
  const team = index < 11 ? cfg.home : cfg.away;
  return team.players[index % 11].name.split(" ").slice(-1)[0];
}

export const minuteOf = (tick: number) => Math.min(90, Math.floor(tick / 600) + 1);

/** Commentary for an event, or null for routine play. Deterministic: chosen from the event's sequence number. */
export function commentary(cfg: MatchConfig, e: MatchEvent): string | null {
  const team = e.team === 0 ? cfg.home.name : e.team === 1 ? cfg.away.name : "";
  const p = playerName(cfg, e.player);
  const o = playerName(cfg, e.other);
  switch (e.type) {
    case "kickoff":
      return e.tick === 0
        ? `We're under way. ${team} get us started.`
        : pick(e.seq, [`${team} restart from the centre spot.`, `Play resumes, ${team} to kick off.`]);
    case "goal":
      return e.player < 0
        ? `GOAL! An own goal hands ${team} the lead-changer. ${e.home}-${e.away}.`
        : `GOAL! ${p} scores for ${team}${o ? `, set up by ${o}` : ""}. ${e.home}-${e.away}.`;
    case "shot":
      return e.ok
        ? pick(e.seq, [`${p} tests the keeper.`, `${p} gets a shot away on target.`, `Effort from ${p}, on target.`])
        : pick(e.seq, [`${p} fires wide.`, `${p} shoots, but it's off target.`, `Over the bar from ${p}.`]);
    case "save":
      return pick(e.seq, [`Good save by ${p}.`, `${p} gets down well to keep it out.`, `${p} stands tall and saves.`]);
    case "block":
      return `${p} throws a body in the way. Blocked.`;
    case "corner":
      return `Corner to ${team}.`;
    case "foul":
      return `Foul by ${p}${o ? ` on ${o}` : ""}.`;
    case "free_kick":
      return `${team} free kick, ${p} standing over it.`;
    case "penalty":
      return `PENALTY to ${team}! ${p} steps up.`;
    case "halftime":
      return `Half-time: ${cfg.home.short} ${e.home}-${e.away} ${cfg.away.short}.`;
    case "fulltime":
      return `Full-time: ${cfg.home.name} ${e.home}-${e.away} ${cfg.away.name}.`;
    case "tackle":
      return e.ok && e.seq % 3 === 0 ? `Strong challenge from ${p} to win it back.` : null;
    case "interception":
      return e.seq % 4 === 0 ? `${p} reads it and intercepts.` : null;
    default:
      return null;
  }
}
