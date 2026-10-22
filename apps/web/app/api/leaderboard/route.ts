import { db, hasDatabase } from "@oddra/db";
import { exchangeMode } from "@/lib/config";
import { ok, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Prediction leaderboard: correct predictions, accuracy and participation, from settled on-chain bets only.
 * Deliberately not ranked by money won.
 */
export async function GET() {
  if (!hasDatabase()) return unavailable();
  type Row = { bettor: string; settled: bigint; correct: bigint; matches: bigint; first_bet: Date };
  // on the exchange both sides of a position are players: backers are right when BACK wins, layers when LAY wins
  const rows = exchangeMode
    ? await db().$queryRaw<Row[]>`
    WITH sides AS (
      SELECT backer AS bettor, "matchId", "createdAt", winner, 'BACK' AS side FROM "ExchangePosition"
      UNION ALL
      SELECT layer AS bettor, "matchId", "createdAt", winner, 'LAY' AS side FROM "ExchangePosition"
    )
    SELECT bettor,
           COUNT(*) FILTER (WHERE winner IN ('BACK', 'LAY')) AS settled,
           COUNT(*) FILTER (WHERE winner = side) AS correct,
           COUNT(DISTINCT "matchId") AS matches,
           MIN("createdAt") AS first_bet
    FROM sides
    GROUP BY bettor
    HAVING COUNT(*) FILTER (WHERE winner IN ('BACK', 'LAY')) > 0
    ORDER BY correct DESC, settled ASC
    LIMIT 100`
    : await db().$queryRaw<Row[]>`
    SELECT b.bettor,
           COUNT(*) FILTER (WHERE s."betId" IS NOT NULL AND NOT s.refund) AS settled,
           COUNT(*) FILTER (WHERE s.won) AS correct,
           COUNT(DISTINCT b."matchId") AS matches,
           MIN(b."placedAt") AS first_bet
    FROM "Bet" b LEFT JOIN "BetSettlement" s ON s."betId" = b.id
    GROUP BY b.bettor
    HAVING COUNT(*) FILTER (WHERE s."betId" IS NOT NULL AND NOT s.refund) > 0
    ORDER BY correct DESC, settled ASC
    LIMIT 100`;
  return ok(
    {
      available: true,
      rows: rows.map((r) => ({
        bettor: r.bettor,
        settled: Number(r.settled),
        correct: Number(r.correct),
        accuracy: Number(r.settled) ? Number(r.correct) / Number(r.settled) : 0,
        matches: Number(r.matches),
        since: r.first_bet,
      })),
    },
    30,
  );
}
