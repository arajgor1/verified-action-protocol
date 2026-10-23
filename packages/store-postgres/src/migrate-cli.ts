import pg from "pg";
import { migrate } from "./migrate.js";

// Run by the dedicated migration identity, never by the runtime service identity.
const url = process.env.VAP_MIGRATION_DATABASE_URL ?? process.env.VAP_DATABASE_URL;
if (!url) {
  process.stderr.write("VAP_MIGRATION_DATABASE_URL (or VAP_DATABASE_URL) is required\n");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const report = await migrate(pool);
  process.stdout.write(JSON.stringify({ severity: "INFO", message: "migrations complete", ...report }) + "\n");
} catch (e) {
  process.stderr.write(JSON.stringify({ severity: "ERROR", message: (e as Error).message }) + "\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
