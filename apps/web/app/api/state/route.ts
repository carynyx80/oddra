import { noStore } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Proxies the worker's public /state snapshot (safe-state reason, current phase) when WORKER_URL is configured. */
export async function GET() {
  const base = process.env.WORKER_URL;
  if (!base) return noStore({ available: false });
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/state`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    return noStore({ available: true, ...(await r.json()) });
  } catch {
    return noStore({ available: false, reason: "worker unreachable" }, 502);
  }
}
