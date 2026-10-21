import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/** Admin sessions: wallet signature over a one-time nonce, then an HMAC-signed, httpOnly cookie (8 hours). */
const COOKIE = "oddra_admin";
const TTL = 8 * 3600;

export const adminAllowlist = () =>
  (process.env.ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

function secret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("ADMIN_SESSION_SECRET must be set (32+ characters)");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export const newNonce = () => randomBytes(16).toString("hex");

export function adminMessage(address: string, nonce: string) {
  return `Oddra operations sign-in\n\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}\n\nThis signature only proves you control this wallet. It costs nothing and moves no funds.`;
}

export async function setSession(address: string) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const payload = `${address.toLowerCase()}.${exp}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: TTL,
  });
}

export async function sessionAddress(): Promise<string | null> {
  const c = (await cookies()).get(COOKIE)?.value;
  if (!c) return null;
  const [addr, exp, sig] = c.split(".");
  if (!addr || !exp || !sig) return null;
  const expected = Buffer.from(sign(`${addr}.${exp}`));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return adminAllowlist().includes(addr) ? addr : null;
}
