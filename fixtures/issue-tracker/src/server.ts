import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createPool, ensureSchema, withTx } from "./db.js";
import { handleGithub, handleGithubControl, newGhFaults } from "./github-api.js";
import type { GhContext } from "./github-api.js";

/**
 * Deterministic issue-tracker fixture for VAP demonstrations and tests. It is a synthetic
 * destination with persistent resource versions, request-key lookup with sealing, delayed
 * visibility, conflict injection, validation failure and reply-loss injection. Fault
 * controls exist only on a separate control listener enabled for the test harness; they
 * are not part of the VAP runtime API.
 */

export const OWNERS = ["alice", "bob", "carol", "dave", "erin"];
const STATUSES = ["open", "in_progress", "closed"];
const PRIORITIES = ["low", "medium", "high"];

export interface Issue {
  id: string;
  title: string;
  owner: string;
  status: string;
  priority: string;
  version: number;
}

interface Faults {
  reject_validation: number;
  lost_reply: number;
  server_error_after_commit: number;
  delay_visibility: { count: number; ms: number };
  partial_batch: { count: number; fail_after: number };
}

/**
 * Faults keyed by the owner an issue update sets, configured at startup. Unlike the control
 * listener's counters they live in the configuration, so every instance of a horizontally
 * scaled fixture (Cloud Run) applies them identically and a test can aim a fault at one
 * operation by its owner argument. Test harness only: requires test controls.
 */
export type OwnerFaults = Record<string, { delay_visibility_ms?: number; lost_reply?: boolean }>;

/** Parses FIXTURE_OWNER_FAULTS. Throws on malformed input or when test controls are off. */
export function parseOwnerFaults(raw: string | undefined, testControls: boolean): OwnerFaults | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!testControls) throw new Error("FIXTURE_OWNER_FAULTS requires FIXTURE_TEST_CONTROLS=1");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("FIXTURE_OWNER_FAULTS must be a JSON object keyed by owner");
  const out: OwnerFaults = {};
  for (const [owner, f] of Object.entries(parsed as Record<string, unknown>)) {
    if (!OWNERS.includes(owner)) throw new Error(`FIXTURE_OWNER_FAULTS: unknown owner ${owner}`);
    if (typeof f !== "object" || f === null) throw new Error(`FIXTURE_OWNER_FAULTS: ${owner} must map to an object`);
    const { delay_visibility_ms: d, lost_reply: l, ...rest } = f as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`FIXTURE_OWNER_FAULTS: unknown fields for ${owner}`);
    if (d !== undefined && (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 600_000)) throw new Error(`FIXTURE_OWNER_FAULTS: delay_visibility_ms for ${owner} must be 0-600000`);
    if (l !== undefined && typeof l !== "boolean") throw new Error(`FIXTURE_OWNER_FAULTS: lost_reply for ${owner} must be a boolean`);
    out[owner] = { ...(d !== undefined ? { delay_visibility_ms: d as number } : {}), ...(l !== undefined ? { lost_reply: l } : {}) };
  }
  return out;
}

export interface FixtureOptions {
  databaseUrl: string;
  host?: string;
  port: number;
  /** Enables the fault-control listener (test harness only). */
  testControls?: boolean;
  /** Owner-keyed faults for issue updates (test harness only; see parseOwnerFaults). */
  ownerFaults?: OwnerFaults;
  /** Repositories ("owner/repo") served by the GitHub-compatible /gh API. */
  githubRepos?: string[];
  controlHost?: string;
  controlPort?: number;
}

export interface FixtureHandle {
  url: string;
  controlUrl: string | null;
  pool: Pool;
  close(): Promise<void>;
}

type Result = { status: number; body: unknown; headers?: Record<string, string>; lostReplyEligible?: boolean; forceLostReply?: boolean };

const MAX_BODY = 256 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function validateIssueInput(b: Record<string, unknown>, partial: boolean): { field: string; code: string }[] {
  const errors: { field: string; code: string }[] = [];
  if (!partial || "title" in b) {
    if (typeof b.title !== "string") errors.push({ field: "title", code: "required" });
    else if (b.title.trim().length < 3) errors.push({ field: "title", code: "too_short" });
    else if (b.title.length > 200) errors.push({ field: "title", code: "too_long" });
  }
  if (!partial || "owner" in b) {
    if (typeof b.owner !== "string" || !OWNERS.includes(b.owner)) errors.push({ field: "owner", code: "unknown_owner" });
  }
  if ("status" in b && (typeof b.status !== "string" || !STATUSES.includes(b.status))) errors.push({ field: "status", code: "invalid_status" });
  if ("priority" in b && b.priority !== undefined && (typeof b.priority !== "string" || !PRIORITIES.includes(b.priority))) errors.push({ field: "priority", code: "invalid_priority" });
  return errors;
}

export async function startFixture(opts: FixtureOptions): Promise<FixtureHandle> {
  const pool = createPool(opts.databaseUrl);
  await ensureSchema(pool);
  const faults: Faults = {
    reject_validation: 0,
    lost_reply: 0,
    server_error_after_commit: 0,
    delay_visibility: { count: 0, ms: 0 },
    partial_batch: { count: 0, fail_after: 0 },
  };
  let noiseTick = 0;
  const gh: GhContext = {
    pool,
    faults: newGhFaults(),
    allowedRepos: opts.githubRepos ?? ["vap-demo/ci-failures"],
    readJson,
    withTx: (fn) => withTx(pool, fn),
  };

  const takeDelay = (): number => {
    if (faults.delay_visibility.count > 0) {
      faults.delay_visibility.count--;
      return faults.delay_visibility.ms;
    }
    return 0;
  };

  async function recordVersion(c: PoolClient, issue: Issue, delayMs: number): Promise<void> {
    await c.query("INSERT INTO fx_issue_versions (issue_id, version, data, visible_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision))", [
      issue.id,
      issue.version,
      JSON.stringify(issue),
      delayMs / 1000,
    ]);
  }

  async function createIssue(c: PoolClient, input: Record<string, unknown>, key: string | null, delayMs: number, actor: string): Promise<Issue> {
    const id = String((await c.query<{ id: string }>("SELECT nextval('fx_issue_ids')::text AS id")).rows[0].id);
    const issue: Issue = { id, title: String(input.title), owner: String(input.owner), status: "open", priority: typeof input.priority === "string" ? input.priority : "medium", version: 1 };
    await c.query("INSERT INTO fx_issues (id, title, owner, status, priority, version, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, issue.title, issue.owner, issue.status, issue.priority, 1, actor]);
    await recordVersion(c, issue, delayMs);
    // Irreversible side effect, only when requested: a notification compensation cannot recall.
    if (input.notify === true) await c.query("INSERT INTO fx_notifications (issue_id, kind) VALUES ($1, 'issue_created')", [id]);
    await c.query("INSERT INTO fx_write_log (request_key, kind, issue_id) VALUES ($1, 'create', $2)", [key, id]);
    return issue;
  }

  async function lockIssue(c: PoolClient, id: string): Promise<Issue | null> {
    if (!/^\d{1,18}$/.test(id)) return null;
    const r = await c.query("SELECT id::text, title, owner, status, priority, version FROM fx_issues WHERE id = $1 FOR UPDATE", [id]);
    return (r.rows[0] as Issue | undefined) ?? null;
  }

  async function updateIssue(c: PoolClient, cur: Issue, changes: Record<string, unknown>, key: string | null, delayMs: number, actor: string): Promise<Issue> {
    const next: Issue = {
      ...cur,
      title: typeof changes.title === "string" ? changes.title : cur.title,
      owner: typeof changes.owner === "string" ? changes.owner : cur.owner,
      status: typeof changes.status === "string" ? changes.status : cur.status,
      version: cur.version + 1,
    };
    await c.query("UPDATE fx_issues SET title = $2, owner = $3, status = $4, version = $5, updated_by = $6, updated_at = now() WHERE id = $1", [cur.id, next.title, next.owner, next.status, next.version, actor]);
    await recordVersion(c, next, delayMs);
    await c.query("INSERT INTO fx_write_log (request_key, kind, issue_id) VALUES ($1, 'update', $2)", [key, cur.id]);
    return next;
  }

  /**
   * Request-key protocol. The key row is inserted in the same transaction as the effect, so
   * a lookup can never disagree with what committed. A sealed key (created by a lookup with
   * seal=1) rejects late arrivals, which makes "not found" definitive.
   */
  async function withKey(c: PoolClient, key: string | null, fn: () => Promise<Result>): Promise<Result & { replay?: boolean }> {
    if (!key) return fn();
    if (key.length > 200) return { status: 400, body: { errors: [{ field: "idempotency_key", code: "too_long" }] } };
    const ins = await c.query("INSERT INTO fx_requests (key, status) VALUES ($1, 'applied') ON CONFLICT DO NOTHING RETURNING key", [key]);
    if (ins.rowCount === 0) {
      const ex = (await c.query<{ status: string; response: { http_status: number; body: unknown } | null }>("SELECT status, response FROM fx_requests WHERE key = $1 FOR UPDATE", [key])).rows[0];
      if (ex.status === "sealed") return { status: 409, body: { error: "request_key_sealed" } };
      return { status: ex.response?.http_status ?? 200, body: ex.response?.body ?? null, replay: true };
    }
    const res = await fn();
    const status = res.status >= 400 && res.status < 500 ? "rejected" : "applied";
    await c.query("UPDATE fx_requests SET status = $2, response = $3 WHERE key = $1", [key, status, JSON.stringify({ http_status: res.status, body: res.body })]);
    return res;
  }

  function header(req: IncomingMessage, name: string): string | null {
    const v = req.headers[name];
    return typeof v === "string" ? v : null;
  }

  async function handle(req: IncomingMessage, url: URL): Promise<Result> {
    const method = req.method ?? "GET";
    const p = url.pathname;
    const key = header(req, "idempotency-key");

    if (method === "GET" && p === "/healthz") return { status: 200, body: { ok: true } };
    if (method === "GET" && p === "/noise") return { status: 200, body: { tick: ++noiseTick } };

    if (method === "GET" && p === "/form") return { status: 200, body: formPage(), headers: { "content-type": "text/html; charset=utf-8" } };

    let m = /^\/issues\/(\d{1,18})$/.exec(p);
    if (method === "GET" && m) {
      // Eventually consistent read model: the newest version whose visibility time has passed.
      const r = await pool.query<{ data: Issue }>("SELECT data FROM fx_issue_versions WHERE issue_id = $1 AND visible_at <= now() ORDER BY version DESC LIMIT 1", [m[1]]);
      const issue = r.rows[0]?.data;
      if (!issue) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: issue, headers: { etag: `"${issue.version}"` } };
    }

    m = /^\/issues\/(\d{1,18})\/view$/.exec(p);
    if (method === "GET" && m) {
      const r = await pool.query<{ data: Issue }>("SELECT data FROM fx_issue_versions WHERE issue_id = $1 AND visible_at <= now() ORDER BY version DESC LIMIT 1", [m[1]]);
      const i = r.rows[0]?.data;
      const html = i
        ? `<!doctype html><html><head><title>Issue ${esc(i.id)}</title></head><body><h1>Issue ${esc(i.id)}</h1><div data-issue-view data-id="${esc(i.id)}" data-title="${esc(i.title)}" data-owner="${esc(i.owner)}" data-status="${esc(i.status)}" data-version="${esc(i.version)}"><p>${esc(i.title)}</p><p>Owner: ${esc(i.owner)}</p></div></body></html>`
        : `<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>`;
      return { status: i ? 200 : 404, body: html, headers: { "content-type": "text/html; charset=utf-8" } };
    }

    m = /^\/requests\/([\x21-\x7e]{1,200})$/.exec(p);
    if (method === "GET" && m) {
      const k = decodeURIComponent(m[1]);
      const seal = url.searchParams.get("seal") === "1";
      return withTx(pool, async (c) => {
        if (seal) {
          const ins = await c.query("INSERT INTO fx_requests (key, status) VALUES ($1, 'sealed') ON CONFLICT DO NOTHING RETURNING key", [k]);
          if (ins.rowCount === 1) return { status: 404, body: { key: k, status: "not_found", sealed: true } };
        }
        const r = await c.query<{ status: string; response: unknown }>("SELECT status, response FROM fx_requests WHERE key = $1", [k]);
        const row = r.rows[0];
        if (!row) return { status: 404, body: { key: k, status: "not_found", sealed: false } };
        if (row.status === "sealed") return { status: 404, body: { key: k, status: "not_found", sealed: true } };
        return { status: 200, body: { key: k, status: row.status, response: row.response } };
      });
    }

    if (method === "POST" && (p === "/issues" || p === "/api/form-submit")) {
      const formKey = p === "/api/form-submit" ? header(req, "x-client-action-id") : key;
      const body = (await readJson(req)) as Record<string, unknown>;
      const res = await withTx(pool, (c) =>
        withKey(c, formKey, async () => {
          if (faults.reject_validation > 0) {
            faults.reject_validation--;
            return { status: 422, body: { errors: [{ field: "title", code: "rejected_by_fault_injection" }] } };
          }
          const errors = validateIssueInput(body, false);
          if (errors.length > 0) return { status: 422, body: { errors } };
          const issue = await createIssue(c, body, formKey, takeDelay(), p === "/api/form-submit" ? "browser" : "api");
          return { status: 201, body: issue, headers: { etag: `"${issue.version}"` } };
        }),
      );
      const headers = { ...(res.headers ?? {}), ...(formKey && p === "/api/form-submit" ? { "x-fixture-request-id": formKey } : {}) };
      return { ...res, headers, lostReplyEligible: !res.replay };
    }

    m = /^\/issues\/(\d{1,18})$/.exec(p);
    if (method === "PATCH" && m) {
      const id = m[1];
      const body = (await readJson(req)) as Record<string, unknown>;
      const ifMatch = header(req, "if-match")?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const res = await withTx(pool, (c) =>
        withKey(c, key, async () => {
          if (faults.reject_validation > 0) {
            faults.reject_validation--;
            return { status: 422, body: { errors: [{ field: "owner", code: "rejected_by_fault_injection" }] } };
          }
          const allowed = Object.fromEntries(Object.entries(body).filter(([k]) => ["owner", "status", "title"].includes(k)));
          const errors = validateIssueInput(allowed, true);
          if (errors.length > 0) return { status: 422, body: { errors } };
          const cur = await lockIssue(c, id);
          if (!cur) return { status: 404, body: { error: "not_found" } };
          if (ifMatch !== null && String(cur.version) !== ifMatch) return { status: 412, body: { error: "version_mismatch", current_version: cur.version } };
          const ownerFault = typeof allowed.owner === "string" ? opts.ownerFaults?.[allowed.owner] : undefined;
          const delayMs = ownerFault?.delay_visibility_ms !== undefined ? ownerFault.delay_visibility_ms : takeDelay();
          const next = await updateIssue(c, cur, allowed, key, delayMs, "api");
          return { status: 200, body: next, headers: { etag: `"${next.version}"` } };
        }),
      );
      const replyFault = typeof body.owner === "string" ? opts.ownerFaults?.[body.owner] : undefined;
      return { ...res, lostReplyEligible: !res.replay, forceLostReply: replyFault?.lost_reply === true };
    }

    if (method === "POST" && p === "/issues/batch") {
      const body = (await readJson(req)) as { items?: unknown };
      const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : null;
      if (!items || items.length === 0 || items.length > 50) return { status: 422, body: { errors: [{ field: "items", code: "invalid" }] } };
      const res = await withTx(pool, (c) =>
        withKey(c, key, async () => {
          let failAfter = Number.POSITIVE_INFINITY;
          if (faults.partial_batch.count > 0) {
            faults.partial_batch.count--;
            failAfter = faults.partial_batch.fail_after;
          }
          const delayMs = takeDelay();
          const results: Record<string, unknown>[] = [];
          for (let i = 0; i < items.length; i++) {
            const errors = validateIssueInput(items[i], false);
            if (i >= failAfter) {
              results.push({ index: i, status: "failed", error: "downstream_capacity" });
            } else if (errors.length > 0) {
              results.push({ index: i, status: "failed", error: errors[0].code });
            } else {
              const issue = await createIssue(c, items[i], key, delayMs, "api");
              results.push({ index: i, status: "applied", id: issue.id, version: issue.version });
            }
          }
          const applied = results.filter((r) => r.status === "applied").length;
          return { status: applied === items.length ? 201 : applied === 0 ? 422 : 207, body: { items: results } };
        }),
      );
      return { ...res, lostReplyEligible: !res.replay };
    }

    if (method === "POST" && p === "/issues/close") {
      const body = (await readJson(req)) as { issue_ids?: unknown };
      const ids = Array.isArray(body.issue_ids) ? body.issue_ids.map(String) : null;
      if (!ids || ids.length === 0 || ids.length > 50) return { status: 422, body: { errors: [{ field: "issue_ids", code: "invalid" }] } };
      const res = await withTx(pool, (c) =>
        withKey(c, key, async () => {
          const results: Record<string, unknown>[] = [];
          for (const [i, id] of ids.entries()) {
            const cur = await lockIssue(c, id);
            if (!cur) {
              results.push({ index: i, id, status: "failed", error: "not_found" });
              continue;
            }
            const next = cur.status === "closed" ? cur : await updateIssue(c, cur, { status: "closed" }, key, takeDelay(), "api");
            results.push({ index: i, id, status: "applied", version: next.version });
          }
          const applied = results.filter((r) => r.status === "applied").length;
          return { status: applied === ids.length ? 200 : applied === 0 ? 422 : 207, body: { items: results } };
        }),
      );
      return { ...res, lostReplyEligible: !res.replay };
    }

    const g = await handleGithub(gh, req, url);
    if (g) return g;

    return { status: 404, body: { error: "not_found" } };
  }

  async function control(req: IncomingMessage, url: URL): Promise<Result> {
    const p = url.pathname;
    if (req.method === "GET" && p === "/healthz") return { status: 200, body: { ok: true } };
    const g = await handleGithubControl(gh, req, url);
    if (g) return g;
    if (req.method === "POST" && p === "/faults") {
      const b = (await readJson(req)) as Record<string, unknown>;
      const count = typeof b.count === "number" ? b.count : 1;
      switch (b.mode) {
        case "reject_validation":
          faults.reject_validation = count;
          break;
        case "lost_reply":
          faults.lost_reply = count;
          break;
        case "server_error_after_commit":
          faults.server_error_after_commit = count;
          break;
        case "delay_visibility":
          faults.delay_visibility = { count, ms: typeof b.delay_ms === "number" ? b.delay_ms : 2000 };
          break;
        case "partial_batch":
          faults.partial_batch = { count, fail_after: typeof b.fail_after === "number" ? b.fail_after : 1 };
          break;
        case "clear":
          Object.assign(faults, { reject_validation: 0, lost_reply: 0, server_error_after_commit: 0, delay_visibility: { count: 0, ms: 0 }, partial_batch: { count: 0, fail_after: 0 } });
          break;
        default:
          return { status: 400, body: { error: "unknown fault mode" } };
      }
      return { status: 200, body: { faults } };
    }
    if (req.method === "POST" && p === "/independent-edit") {
      const b = (await readJson(req)) as Record<string, unknown>;
      const r = await withTx(pool, async (c) => {
        const cur = await lockIssue(c, String(b.id));
        if (!cur) return null;
        return updateIssue(c, cur, { owner: b.owner, status: b.status }, null, 0, "human");
      });
      return r ? { status: 200, body: r } : { status: 404, body: { error: "not_found" } };
    }
    if (req.method === "GET" && p === "/stats") {
      const q = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0].n);
      const dup = await pool.query<{ request_key: string; n: string }>(
        "SELECT request_key, count(*)::text AS n FROM fx_write_log WHERE request_key IS NOT NULL AND kind = 'create' GROUP BY request_key HAVING count(*) > 1",
      );
      return {
        status: 200,
        body: {
          issues: await q("SELECT count(*)::text AS n FROM fx_issues"),
          notifications: await q("SELECT count(*)::text AS n FROM fx_notifications"),
          writes: await q("SELECT count(*)::text AS n FROM fx_write_log"),
          duplicate_create_keys: dup.rows.map((r) => ({ key: r.request_key, writes: Number(r.n) })),
        },
      };
    }
    if (req.method === "GET" && p.startsWith("/authoritative/")) {
      const id = p.slice("/authoritative/".length);
      if (!/^\d{1,18}$/.test(id)) return { status: 404, body: {} };
      const r = await pool.query("SELECT id::text, title, owner, status, priority, version FROM fx_issues WHERE id = $1", [id]);
      return r.rows[0] ? { status: 200, body: r.rows[0] } : { status: 404, body: {} };
    }
    if (req.method === "GET" && p.startsWith("/writes/")) {
      const k = decodeURIComponent(p.slice("/writes/".length));
      const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM fx_write_log WHERE request_key = $1", [k]);
      return { status: 200, body: { key: k, writes: Number(r.rows[0].n) } };
    }
    if (req.method === "POST" && p === "/reset") {
      await pool.query("TRUNCATE fx_issues, fx_issue_versions, fx_requests, fx_notifications, fx_write_log, fx_gh_issues");
      Object.assign(gh.faults, newGhFaults());
      Object.assign(faults, { reject_validation: 0, lost_reply: 0, server_error_after_commit: 0, delay_visibility: { count: 0, ms: 0 }, partial_batch: { count: 0, fail_after: 0 } });
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not_found" } };
  }

  const respond = (res: ServerResponse, r: Result) => {
    const isHtml = typeof r.body === "string";
    res.writeHead(r.status, { "content-type": isHtml ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", ...(r.headers ?? {}) });
    res.end(isHtml ? (r.body as string) : JSON.stringify(r.body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    handle(req, url)
      .then((r) => {
        const isWrite = req.method !== "GET" && r.status < 300 && r.lostReplyEligible;
        if (isWrite && (r.forceLostReply || faults.lost_reply > 0)) {
          // The write committed; drop the reply so the caller cannot know.
          if (!r.forceLostReply) faults.lost_reply--;
          req.socket.destroy();
          return;
        }
        if (isWrite && faults.server_error_after_commit > 0) {
          faults.server_error_after_commit--;
          respond(res, { status: 503, body: { error: "upstream_timeout" } });
          return;
        }
        respond(res, r);
      })
      .catch((e: Error) => respond(res, { status: e.message === "invalid json" || e.message === "body too large" ? 400 : 500, body: { error: "fixture_error" } }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  let controlServer: http.Server | null = null;
  let controlUrl: string | null = null;
  if (opts.testControls) {
    controlServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://control.invalid");
      control(req, url)
        .then((r) => respond(res, r))
        .catch(() => respond(res, { status: 500, body: { error: "control_error" } }));
    });
    await new Promise<void>((resolve) => controlServer!.listen(opts.controlPort ?? 0, opts.controlHost ?? "127.0.0.1", resolve));
    controlUrl = `http://${opts.controlHost ?? "127.0.0.1"}:${(controlServer.address() as { port: number }).port}`;
  }
  return {
    url: `http://${opts.host === "0.0.0.0" ? "127.0.0.1" : (opts.host ?? "127.0.0.1")}:${addr.port}`,
    controlUrl,
    pool,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (controlServer) await new Promise<void>((r) => controlServer!.close(() => r()));
      await pool.end();
    },
  };
}

function formPage(): string {
  const owners = OWNERS.map((o) => `<option value="${o}">${o}</option>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>New issue</title></head>
<body>
<h1>Create an issue</h1>
<form id="issue-form">
  <label for="title">Title</label> <input id="title" name="title" type="text">
  <label for="owner">Owner</label> <select id="owner" name="owner">${owners}</select>
  <label for="priority">Priority</label> <select id="priority" name="priority"><option>low</option><option selected>medium</option><option>high</option></select>
  <button type="submit">Create issue</button>
</form>
<script>
  const actionId = new URLSearchParams(location.search).get("client_action_id") || "";
  document.getElementById("issue-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { title: document.getElementById("title").value, owner: document.getElementById("owner").value, priority: document.getElementById("priority").value };
    const res = await fetch("/api/form-submit", { method: "POST", headers: { "content-type": "application/json", "x-client-action-id": actionId }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    const out = document.createElement("div");
    out.setAttribute("data-vap-result", "");
    out.setAttribute("data-client-action-id", actionId);
    if (res.status === 201 || res.status === 200) {
      out.dataset.status = "created";
      out.dataset.issueId = data.id;
      out.dataset.version = data.version;
    } else {
      out.dataset.status = "rejected";
      for (const e of data.errors || []) {
        const s = document.createElement("span");
        s.setAttribute("data-field-error", e.field);
        s.textContent = e.code;
        document.body.appendChild(s);
      }
    }
    document.body.appendChild(out);
  });
  // Unrelated background traffic that must never be attributed to the action. One request fires
  // immediately so it is always present, even when the action completes within one interval.
  const poll = () => fetch("/noise").then((r) => r.text()).catch(() => {});
  poll();
  setInterval(poll, 100);
</script>
</body></html>`;
}
