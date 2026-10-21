import { db, hasDatabase } from "@oddra/db";
import { isAddress, noStore, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Transaction hashes and claim history for a wallet (bet state itself is read from the contract). */
export async function GET(req: Request) {
  if (!hasDatabase()) return unavailable();
  const address = new URL(req.url).searchParams.get("address");
  if (!isAddress(address)) return noStore({ error: "address required" }, 400);
  const a = address.toLowerCase();
  const [bets, claims] = await Promise.all([
    db().bet.findMany({ where: { bettor: a }, select: { id: true, txHash: true }, orderBy: { id: "desc" }, take: 500 }),
    db().claim.findMany({ where: { bettor: a }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  return noStore({
    available: true,
    txByBet: Object.fromEntries(bets.map((b) => [b.id.toString(), b.txHash])),
    claims,
  });
}
