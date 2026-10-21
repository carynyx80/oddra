import { db, hasDatabase } from "@oddra/db";
import { ok, unavailable } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasDatabase()) return unavailable();
  const [receipts, conversions] = await Promise.all([
    db().creatorFeeReceipt.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db().tokenConversion.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return ok({ available: true, receipts, conversions }, 30);
}
