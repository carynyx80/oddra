import { db } from "@oddra/db";

/**
 * Leader election through a lease row, timed by the database clock (never this machine's clock). Only the leader
 * sends transactions; a standby takes over within LEASE_SECONDS of the leader dying.
 */
const LEASE_SECONDS = 30;

export async function ensureLeaseTable() {
  await db().$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkerLease" (
      id TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      "leaseUntil" TIMESTAMPTZ NOT NULL
    )`);
}

/** Returns true if `holder` now holds the lease. */
export async function acquireLease(holder: string, id = "scheduler"): Promise<boolean> {
  const rows = await db().$queryRawUnsafe<{ holder: string }[]>(
    `INSERT INTO "WorkerLease" (id, holder, "leaseUntil") VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, "leaseUntil" = EXCLUDED."leaseUntil"
       WHERE "WorkerLease"."leaseUntil" < now() OR "WorkerLease".holder = EXCLUDED.holder
     RETURNING holder`,
    id,
    holder,
    LEASE_SECONDS,
  );
  return rows.length === 1 && rows[0].holder === holder;
}

export async function releaseLease(holder: string, id = "scheduler") {
  await db().$executeRawUnsafe(`DELETE FROM "WorkerLease" WHERE id = $1 AND holder = $2`, id, holder);
}
