import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(new URL(f, dir), "utf8");
      return { version: f.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock.
 * Refuses to run if an applied migration's checksum changed: migrations are append-only and
 * destructive changes are never reversed blindly.
 */
export async function migrate(pool: Pool, migrations: Migration[] = loadMigrations()): Promise<MigrationReport> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('vap_schema_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS vap_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM vap_schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const known = new Set(migrations.map((m) => m.version));
    for (const v of applied.keys()) {
      if (!known.has(v)) throw new Error(`database has migration ${v} that this build does not know; refusing to run an older build against a newer schema`);
    }
    const report: MigrationReport = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const prev = applied.get(m.version);
      if (prev !== undefined) {
        if (prev !== m.checksum) throw new Error(`migration ${m.version} was modified after it was applied (checksum mismatch)`);
        report.alreadyApplied.push(m.version);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO vap_schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
        report.applied.push(m.version);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.version} failed and was rolled back: ${(e as Error).message}`);
      }
    }
    return report;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('vap_schema_migrations'))").catch(() => {});
    client.release();
  }
}

/** Startup check for the runtime: the schema must be exactly at the build's latest migration. */
export async function assertSchemaCurrent(pool: Pool, migrations: Migration[] = loadMigrations()): Promise<void> {
  const latest = migrations[migrations.length - 1]?.version;
  const res = await pool.query<{ version: string }>("SELECT version FROM vap_schema_migrations ORDER BY version DESC LIMIT 1").catch(() => null);
  const current = res?.rows[0]?.version;
  if (current !== latest) {
    throw new Error(`database schema is at ${current ?? "nothing"}, this build expects ${latest}; run migrations with the migration identity first`);
  }
}
