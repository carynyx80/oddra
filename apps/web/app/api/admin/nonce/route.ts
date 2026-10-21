import { db, hasDatabase } from "@oddra/db";
import { adminMessage, newNonce } from "@/lib/server/admin";
import { isAddress, noStore, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!hasDatabase()) return unavailable();
  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!isAddress(address ?? null)) return noStore({ error: "address required" }, 400);
  const nonce = newNonce();
  await db().adminNonce.create({
    data: { nonce, address: address!.toLowerCase(), expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return noStore({ nonce, message: adminMessage(address!, nonce) });
}
