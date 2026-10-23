import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { GH_SCHEMA } from "./github-api.js";

// The fixture keeps its state in its own database, separate from the VAP journal, so that
// readback through the fixture API is a meaningful, independent observation.
export const FIXTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fx_issues (
  id         bigint PRIMARY KEY,
  title      text NOT NULL,
  owner      text NOT NULL,
  status     text NOT NULL,
  priority   text NOT NULL,
  version    integer NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS fx_issue_ids START 1000;
CREATE TABLE IF NOT EXISTS fx_issue_versions (
  issue_id   bigint NOT NULL,
  version    integer NOT NULL,
  data       jsonb NOT NULL,
  visible_at timestamptz NOT NULL,
  PRIMARY KEY (issue_id, version)
);
CREATE TABLE IF NOT EXISTS fx_requests (
  key        text PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('applied','rejected','sealed')),
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fx_notifications (
  id         bigserial PRIMARY KEY,
  issue_id   bigint NOT NULL,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fx_write_log (
  id          bigserial PRIMARY KEY,
  request_key text,
  kind        text NOT NULL,
  issue_id    bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;

export function createPool(url: string): Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", () => {});
  return pool;
}

export async function ensureSchema(pool: Pool): Promise<void> {
  // Lock, DDL and unlock on one connection so the advisory lock cannot leak.
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('fx_schema'))");
    await c.query(FIXTURE_SCHEMA);
    await c.query(GH_SCHEMA);
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('fx_schema'))").catch(() => {});
    c.release();
  }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
