import { db, hasDatabase } from "@oddra/db";
import { ok, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Prediction leaderboard: correct predictions, accuracy and participation, from settled on-chain bets only.
 * Deliberately not ranked by money won.
 */
export async function GET() {
  if (!hasDatabase()) return unavailable();
  const rows = await db().$queryRaw<
    { bettor: string; settled: bigint; correct: bigint; matches: bigint; first_bet: Date }[]
  >`
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
