import { db, hasDatabase } from "@oddra/db";
import { sessionAddress } from "@/lib/server/admin";
import { noStore, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Operations dashboard data. Read-only: no endpoint here can change a match, a price or a balance. */
export async function GET() {
  if (!hasDatabase()) return unavailable();
  const who = await sessionAddress().catch(() => null);
  if (!who) return noStore({ error: "unauthorised" }, 401);
  const prisma = db();
  let worker: unknown = null;
  if (process.env.WORKER_URL) {
    try {
      const r = await fetch(`${process.env.WORKER_URL.replace(/\/$/, "")}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      worker = await r.json();
    } catch (e) {
      worker = { ok: false, error: e instanceof Error ? e.message : "unreachable" };
    }
  }
  const [heartbeats, failedJobs, recentJobs, alerts, events, txs, cursor, pendingPayouts] = await Promise.all([
    prisma.workerHeartbeat.findMany({ orderBy: { beatAt: "desc" }, take: 5 }),
    prisma.schedulerJob.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 20 }),
    prisma.schedulerJob.findMany({ orderBy: { updatedAt: "desc" }, take: 30 }),
    prisma.alert.findMany({ where: { resolved: false }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.contractEvent.findMany({ orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }], take: 40 }),
    prisma.blockchainTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.indexerCursor.findUnique({ where: { id: "main" } }),
    prisma.bet.count({ where: { state: { in: ["WON", "REFUND"] } } }),
  ]);
  await prisma.adminAuditLog.create({ data: { actor: who, action: "view-status" } });
  return noStore({
    admin: who,
    worker,
    heartbeats,
    failedJobs,
    recentJobs,
    alerts,
    events,
    txs,
    cursor,
    pendingPayouts,
  });
}
