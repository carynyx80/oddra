import { db, hasDatabase } from "@oddra/db";
import { ok, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Settled and voided match history (newest first), paginated by match id. Live matches come from the chain. */
export async function GET(req: Request) {
  if (!hasDatabase()) return unavailable();
  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 30));
  const rows = await db().match.findMany({
    where: {
      status: { in: ["SETTLED", "VOIDED"] },
      ...(before && /^\d+$/.test(before) ? { id: { lt: BigInt(before) } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
    select: {
      id: true,
      homeTeamId: true,
      awayTeamId: true,
      kickoff: true,
      status: true,
      homeGoals: true,
      awayGoals: true,
      firstScorer: true,
      resultHash: true,
      finalSeed: true,
      verifiedAt: true,
      bookSettled: true,
      _count: { select: { bets: true } },
    },
  });
  return ok({ available: true, matches: rows }, 10);
}
