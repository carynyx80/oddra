import { createPublicClient, http } from "viem";
import { db, hasDatabase } from "@oddra/db";
import { chain, rpcUrl } from "@/lib/config";
import { noStore } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = { ok: true, chainId: chain.id };
  try {
    const b = await createPublicClient({ chain, transport: http(rpcUrl) }).getBlock({ blockTag: "latest" });
    out.chain = { block: b.number.toString(), timestamp: Number(b.timestamp) };
  } catch (e) {
    out.ok = false;
    out.chain = { error: e instanceof Error ? e.message : String(e) };
  }
  if (hasDatabase()) {
    try {
      await db().$queryRaw`SELECT 1`;
      out.database = "ok";
    } catch {
      out.ok = false;
      out.database = "error";
    }
  } else out.database = "not configured";
  return noStore(out, out.ok ? 200 : 503);
}
