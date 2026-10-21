// Starts a throwaway local PostgreSQL for development and tests (no Docker needed). Not for production.
import EmbeddedPostgres from "embedded-postgres";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.env.PGDATA_DIR ?? ".pgdata");
const port = Number(process.env.PGPORT ?? 54329);
mkdirSync(dir, { recursive: true });
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "oddra", password: "oddra", port, persistent: true });

const fresh = !(await import("node:fs")).existsSync(resolve(dir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase("oddra");
} catch {
  // exists
}
console.log(`postgres ready: postgresql://oddra:oddra@127.0.0.1:${port}/oddra`);
process.on("SIGINT", async () => {
  await pg.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
