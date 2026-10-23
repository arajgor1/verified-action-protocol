import type { IncomingMessage } from "node:http";
import type { Pool, PoolClient } from "pg";

/**
 * GitHub-compatible issues API subset served by the fixture under /gh, so the same GitHub
 * adapter code runs against a deterministic destination and against the real GitHub REST API.
 * State lives in the fixture database, separate from the VAP journal. Supported:
 *
 *   POST /gh/repos/{owner}/{repo}/issues            create (title, body)
 *   GET  /gh/repos/{owner}/{repo}/issues/{number}   authoritative read
 *   GET  /gh/repos/{owner}/{repo}/issues?state=all&per_page=&page=&since=   list, newest first
 *
 * Test controls (control listener only): reject the next N creates, delay visibility of the
 * next N creates in list/get, make listing unavailable (503), and ground-truth counts.
 */

export const GH_SCHEMA = `
CREATE TABLE IF NOT EXISTS fx_gh_issues (
  id         bigserial PRIMARY KEY,
  owner      text NOT NULL,
  repo       text NOT NULL,
  number     integer NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  state      text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  visible_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, repo, number)
);
ALTER TABLE fx_gh_issues ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT 'vap-demo-bot';
`;

/** Account every issue created through the /gh API is attributed to (the "app bot"). */
export const FIXTURE_BOT_LOGIN = "vap-demo-bot";

export interface GhFaults {
  reject: number;
  delay: { count: number; ms: number };
  listUnavailable: number;
}

export function newGhFaults(): GhFaults {
  return { reject: 0, delay: { count: 0, ms: 0 }, listUnavailable: 0 };
}

interface GhRow {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  created_at: Date;
  updated_at: Date;
}

type Result = { status: number; body: unknown; headers?: Record<string, string>; lostReplyEligible?: boolean };

const API_BASE = "https://fixture-gh.invalid";
const HTML_BASE = "https://fixture-github.invalid";

function toIssue(r: GhRow) {
  return {
    id: Number(r.id),
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    user: { login: r.author, type: r.author === FIXTURE_BOT_LOGIN ? "Bot" : "User" },
    html_url: `${HTML_BASE}/${r.owner}/${r.repo}/issues/${r.number}`,
    url: `${API_BASE}/repos/${r.owner}/${r.repo}/issues/${r.number}`,
    repository_url: `${API_BASE}/repos/${r.owner}/${r.repo}`,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export interface GhContext {
  pool: Pool;
  faults: GhFaults;
  allowedRepos: string[];
  readJson(req: IncomingMessage): Promise<unknown>;
  withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
}

/** Returns null when the path is not part of the /gh API. */
export async function handleGithub(ctx: GhContext, req: IncomingMessage, url: URL): Promise<Result | null> {
  const m = /^\/gh\/repos\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/issues(?:\/(\d{1,9}))?$/.exec(url.pathname);
  if (!m) return null;
  const [, owner, repo, num] = m;
  if (!ctx.allowedRepos.includes(`${owner}/${repo}`)) return { status: 404, body: { message: "Not Found" } };
  const method = req.method ?? "GET";

  if (method === "POST" && !num) {
    const body = (await ctx.readJson(req)) as { title?: unknown; body?: unknown };
    if (ctx.faults.reject > 0) {
      ctx.faults.reject--;
      return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Issue", code: "custom", field: "title", message: "rejected by fault injection" }] } };
    }
    if (typeof body.title !== "string" || body.title.trim() === "" || body.title.length > 256) {
      return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title" }] } };
    }
    if (body.body !== undefined && (typeof body.body !== "string" || body.body.length > 65536)) {
      return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "Issue", code: "invalid", field: "body" }] } };
    }
    let delayMs = 0;
    if (ctx.faults.delay.count > 0) {
      ctx.faults.delay.count--;
      delayMs = ctx.faults.delay.ms;
    }
    const row = await ctx.withTx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fx_gh:${owner}/${repo}`]);
      const n = Number((await c.query<{ n: string }>("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM fx_gh_issues WHERE owner = $1 AND repo = $2", [owner, repo])).rows[0].n);
      const r = await c.query<GhRow>(
        `INSERT INTO fx_gh_issues (owner, repo, number, title, body, visible_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision)) RETURNING *`,
        [owner, repo, n, body.title, typeof body.body === "string" ? body.body : "", delayMs / 1000],
      );
      return r.rows[0];
    });
    return { status: 201, body: toIssue(row), lostReplyEligible: true };
  }

  if (method === "GET" && num) {
    const r = await ctx.pool.query<GhRow>("SELECT * FROM fx_gh_issues WHERE owner = $1 AND repo = $2 AND number = $3 AND visible_at <= now()", [owner, repo, Number(num)]);
    return r.rows[0] ? { status: 200, body: toIssue(r.rows[0]) } : { status: 404, body: { message: "Not Found" } };
  }

  if (method === "GET" && !num) {
    if (ctx.faults.listUnavailable > 0) {
      ctx.faults.listUnavailable--;
      return { status: 503, body: { message: "Service Unavailable" } };
    }
    const perPage = Math.min(Math.max(Number(url.searchParams.get("per_page") ?? 30) || 30, 1), 100);
    const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
    const since = url.searchParams.get("since");
    // Every fixture issue is authored by the synthetic bot account.
    const creator = url.searchParams.get("creator");
    const params: unknown[] = [owner, repo, perPage, (page - 1) * perPage];
    let sinceSql = "";
    if (creator !== null) {
      params.push(creator);
      sinceSql += ` AND author = $${params.length}`;
    }
    if (since && !Number.isNaN(Date.parse(since))) {
      params.push(new Date(since).toISOString());
      sinceSql += ` AND updated_at >= $${params.length}`;
    }
    const r = await ctx.pool.query<GhRow>(
      `SELECT * FROM fx_gh_issues WHERE owner = $1 AND repo = $2 AND visible_at <= now()${sinceSql} ORDER BY created_at DESC, number DESC LIMIT $3 OFFSET $4`,
      params,
    );
    return { status: 200, body: r.rows.map(toIssue) };
  }
  return { status: 404, body: { message: "Not Found" } };
}

/** Control-listener endpoints for /gh faults and evaluator ground truth. */
export async function handleGithubControl(ctx: GhContext, req: IncomingMessage, url: URL): Promise<Result | null> {
  if (req.method === "POST" && url.pathname === "/gh/faults") {
    const b = (await ctx.readJson(req)) as { mode?: string; count?: number; delay_ms?: number };
    const count = typeof b.count === "number" ? b.count : 1;
    if (b.mode === "reject") ctx.faults.reject = count;
    else if (b.mode === "delay_visibility") ctx.faults.delay = { count, ms: typeof b.delay_ms === "number" ? b.delay_ms : 3000 };
    else if (b.mode === "list_unavailable") ctx.faults.listUnavailable = count;
    else if (b.mode === "clear") Object.assign(ctx.faults, newGhFaults());
    else return { status: 400, body: { error: "unknown gh fault mode" } };
    return { status: 200, body: { faults: ctx.faults } };
  }
  if (req.method === "POST" && url.pathname === "/gh/plant") {
    // Another GitHub account files an issue (test control only; agents cannot reach this).
    const b = (await ctx.readJson(req)) as { repository?: string; title?: string; body?: string; author?: string };
    const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(b.repository ?? "");
    if (!m || typeof b.title !== "string" || typeof b.body !== "string" || !/^[A-Za-z0-9[\]_-]{1,60}$/.test(b.author ?? "")) return { status: 400, body: { error: "repository, title, body and author are required" } };
    const row = await ctx.withTx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fx_gh:${m[1]}/${m[2]}`]);
      const n = Number((await c.query<{ n: string }>("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM fx_gh_issues WHERE owner = $1 AND repo = $2", [m[1], m[2]])).rows[0].n);
      return (await c.query<GhRow>("INSERT INTO fx_gh_issues (owner, repo, number, title, body, author) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *", [m[1], m[2], n, b.title, b.body, b.author])).rows[0];
    });
    return { status: 201, body: toIssue(row) };
  }
  if (req.method === "GET" && url.pathname === "/gh/ground-truth") {
    // Evaluator view: ignores visibility delays; counts issues whose body carries the marker.
    const marker = url.searchParams.get("marker") ?? "";
    if (!/^vapwf-[0-9a-f]{24}$/.test(marker)) return { status: 400, body: { error: "marker required" } };
    const r = await ctx.pool.query<GhRow>("SELECT * FROM fx_gh_issues WHERE body LIKE $1 ORDER BY number", [`%vap-workflow-id: ${marker}%`]);
    return { status: 200, body: { marker, count: r.rows.length, issues: r.rows.map((x) => ({ repository: `${x.owner}/${x.repo}`, number: x.number, title: x.title, body: x.body, author: x.author })) } };
  }
  return null;
}
