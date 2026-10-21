import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const g = globalThis as unknown as { __oddraPrisma?: PrismaClient };

/** One Prisma client per process (and per hot-reload in Next.js dev). */
export function db(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  g.__oddraPrisma ??= new PrismaClient({ log: ["warn", "error"] });
  return g.__oddraPrisma;
}

export const hasDatabase = () => Boolean(process.env.DATABASE_URL);
