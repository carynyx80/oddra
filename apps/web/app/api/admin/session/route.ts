import { verifyMessage } from "viem";
import { db, hasDatabase } from "@oddra/db";
import { adminAllowlist, adminMessage, setSession } from "@/lib/server/admin";
import { isAddress, noStore, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Exchanges a signature over a fresh nonce for an admin session. The nonce is single-use (replay protection). */
export async function POST(req: Request) {
  if (!hasDatabase()) return unavailable();
  const { address, nonce, signature } = (await req.json().catch(() => ({}))) as {
    address?: string;
    nonce?: string;
    signature?: `0x${string}`;
  };
  if (!isAddress(address ?? null) || !nonce || !signature) return noStore({ error: "bad request" }, 400);
  const a = address!.toLowerCase();
  const row = await db().adminNonce.findUnique({ where: { nonce } });
  if (!row || row.address !== a || row.usedAt || row.expiresAt < new Date())
    return noStore({ error: "nonce invalid or expired" }, 401);
  await db().adminNonce.update({ where: { nonce }, data: { usedAt: new Date() } });
  const valid = await verifyMessage({ address: a as `0x${string}`, message: adminMessage(a, nonce), signature }).catch(
    () => false,
  );
  if (!valid) return noStore({ error: "signature invalid" }, 401);
  if (!adminAllowlist().includes(a)) {
    await db().adminAuditLog.create({ data: { actor: a, action: "login-denied" } });
    return noStore({ error: "not an operator" }, 403);
  }
  await setSession(a);
  await db().adminAuditLog.create({ data: { actor: a, action: "login" } });
  return noStore({ ok: true });
}
