import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-instance token bucket for the API (60 requests / minute / IP). Serverless instances do not share memory, so
 * this is a first line of defence; put Vercel's firewall or a shared store in front for production traffic.
 */
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = 60;

export function middleware(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: RATE, at: now };
  b.tokens = Math.min(RATE, b.tokens + ((now - b.at) / 60_000) * RATE);
  b.at = now;
  if (b.tokens < 1)
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "5" } });
  b.tokens -= 1;
  buckets.set(ip, b);
  if (buckets.size > 10_000) buckets.clear();
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
