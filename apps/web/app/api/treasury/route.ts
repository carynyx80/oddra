import { db, hasDatabase } from "@oddra/db";
import { ok, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Chart data: treasury snapshots and the creator-fee contribution history. Live totals are read from the chain. */
export async function GET() {
  if (!hasDatabase()) return unavailable();
  const prisma = db();
  const since = new Date(Date.now() - 14 * 86_400_000);
  const [snapshots, contributions, byKind] = await Promise.all([
    prisma.treasurySnapshot.findMany({ where: { takenAt: { gte: since } }, orderBy: { takenAt: "asc" }, take: 2_000 }),
    prisma.treasuryTransaction.findMany({ where: { kind: "contribution" }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.treasuryTransaction.groupBy({ by: ["kind"], _sum: { amount: true }, _count: true }),
  ]);
  return ok({ available: true, snapshots, contributions, byKind }, 30);
}
