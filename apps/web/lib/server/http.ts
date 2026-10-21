import "server-only";
import { NextResponse } from "next/server";
import { json } from "@/lib/utils";

export const ok = (body: unknown, maxAge = 5) =>
  NextResponse.json(json(body), {
    headers: { "cache-control": `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}` },
  });

export const noStore = (body: unknown, status = 200) =>
  NextResponse.json(json(body), { status, headers: { "cache-control": "no-store" } });

export const unavailable = (what = "database") => noStore({ available: false, reason: `${what} not configured` });

export const isAddress = (s: string | null): s is `0x${string}` => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
