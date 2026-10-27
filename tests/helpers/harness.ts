// Shared integration harness. Requires a real PostgreSQL server (VAP_TEST_ADMIN_URL) and
// runs only in the cloud test containers defined in infra/gcp/cloudbuild.test.yaml.
import "../../scripts/cloud-guard.ts";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildRegistry, loadAdaptersConfig } from "@verified-action-protocol/adapters";
import type { AdaptersConfig } from "@verified-action-protocol/adapters";
import { createApiServer, DemoAuthenticator } from "@verified-action-protocol/api";
import { Coordinator, createLogger } from "@verified-action-protocol/core";
import type { AdapterRegistry, CoordinatorOptions, Logger, Principal } from "@verified-action-protocol/core";
import { startFixture } from "@verified-action-protocol/fixture-issue-tracker";
import type { FixtureHandle } from "@verified-action-protocol/fixture-issue-tracker";
import { PROTOCOL_VERSION } from "@verified-action-protocol/protocol";
import type { Check, Grant, Task } from "@verified-action-protocol/protocol";
import { demoToken, VapClient } from "@verified-action-protocol/sdk";
import { migrate, PgArtifactStore, PgJournal } from "@verified-action-protocol/store-postgres";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CONFIG_PATH = path.join(ROOT, "examples/config/adapters.fixture.json");

export const AGENT: Principal = { id: "demo-agent", roles: ["agent"], authMethod: "demo" };
export const AGENT2: Principal = { id: "demo-agent-2", roles: ["agent"], authMethod: "demo" };
export const OPERATOR: Principal = { id: "demo-operator", roles: ["operator", "viewer"], authMethod: "demo" };
export const APPROVER: Principal = { id: "demo-approver", roles: ["approver"], authMethod: "demo" };

export function adminUrl(): string {
  const url = process.env.VAP_TEST_ADMIN_URL;
  if (!url) throw new Error("VAP_TEST_ADMIN_URL is required; integration tests run only in the cloud test environment");
  return url;
}

function dbUrl(name: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

export async function createDatabase(prefix: string): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    name,
    url: dbUrl(name),
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface HarnessOptions {
  enableBrowser?: boolean;
  coordinator?: Partial<CoordinatorOptions>;
  mutateConfig?: (cfg: AdaptersConfig) => void;
  env?: Record<string, string>;
  logSink?: (line: string) => void;
}

export interface Harness {
  coordinator: Coordinator;
  registry: AdapterRegistry;
  journal: PgJournal;
  journalDb: { name: string; url: string };
  fixture: FixtureHandle;
  apiUrl: string;
  log: Logger;
  workspaceRoot: string;
  client(principal: string): VapClient;
  agent: VapClient;
  agent2: VapClient;
  operator: VapClient;
  approver: VapClient;
  drain(rounds?: number): Promise<number>;
  control(pathname: string, body?: unknown): Promise<any>;
  fault(mode: string, opts?: Record<string, unknown>): Promise<void>;
  seedIssue(owner?: string, title?: string): Promise<{ id: string; version: number }>;
  grant(opts?: Partial<Grant> & { principal?: string }): Promise<Grant>;
  task(grant: Grant, checks: Check[], scope?: Task["scope"], principal?: Principal): Promise<Task>;
  restartCoordinator(): Promise<Coordinator>;
  close(): Promise<void>;
}

export const DIGEST_KEY = "test-digest-key-0123456789abcdef0123456789abcdef";

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const journalDb = await createDatabase("vapj");
  const fixtureDb = await createDatabase("vapf");
  const fixture = await startFixture({ databaseUrl: fixtureDb.url, port: 0, testControls: true });
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "vap-ws-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    VAP_CONNECTOR_ISSUE_TRACKER_ORIGIN: fixture.url,
    VAP_BROWSER_ORIGIN: fixture.url,
    VAP_WORKSPACE_ROOT: workspaceRoot,
    ...(opts.env ?? {}),
  };
  const cfg = loadAdaptersConfig(CONFIG_PATH, env);
  opts.mutateConfig?.(cfg);
  const registry = buildRegistry(cfg, { isolatedTestMode: true, enableBrowser: opts.enableBrowser === true, env });
  const journal = new PgJournal({ connectionString: journalDb.url });
  await migrate(journal.pool);
  const log = createLogger({ level: "debug", sink: opts.logSink ?? (() => {}) });
  const makeCoordinator = () =>
    new Coordinator(journal, registry, {
      digestKey: DIGEST_KEY,
      deploymentId: "test",
      log,
      artifacts: new PgArtifactStore(journal.pool),
      claimLeaseMs: 5000,
      ...opts.coordinator,
    });
  let coordinator = makeCoordinator();
  const server = createApiServer({
    get coordinator() {
      return coordinator;
    },
    auth: new DemoAuthenticator(),
    log,
    limits: { maxRequestBytes: 256 * 1024, maxInFlight: 64, perPrincipalRps: 1000, requestKeyRetentionSeconds: 7 * 24 * 3600 },
    build: { version: "0.1.0-test", commit: null, image_digest: null },
    ready: () => journal.ping(),
  } as Parameters<typeof createApiServer>[0]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = (p: string) => new VapClient({ baseUrl: apiUrl, token: demoToken(p) });

  const control = async (pathname: string, body?: unknown) => {
    const res = await fetch(fixture.controlUrl + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  const h: Harness = {
    get coordinator() {
      return coordinator;
    },
    registry,
    journal,
    journalDb,
    fixture,
    apiUrl,
    log,
    workspaceRoot,
    client,
    agent: client("demo-agent"),
    agent2: client("demo-agent-2"),
    operator: client("demo-operator"),
    approver: client("demo-approver"),
    async drain(rounds = 20) {
      let total = 0;
      for (let i = 0; i < rounds; i++) {
        const n = await coordinator.drainOutbox("test-worker", 50);
        total += n;
        if (n === 0) break;
      }
      return total;
    },
    control,
    async fault(mode, o = {}) {
      await control("/faults", { mode, ...o });
    },
    async seedIssue(owner = "alice", title = "Seeded issue") {
      const res = await fetch(fixture.url + "/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, owner }) });
      const b = (await res.json()) as { id: string; version: number };
      return { id: b.id, version: b.version };
    },
    async grant(g = {}) {
      return coordinator.createGrant(OPERATOR, {
        protocol_version: PROTOCOL_VERSION,
        principal: g.principal ?? "demo-agent",
        allowed_actions: g.allowed_actions ?? ["issues.*", "cli.*", "browser.*"],
        allowed_targets: g.allowed_targets ?? ["issue://issue-tracker/*", "workspace://*", "browser://issue-tracker/*"],
        risk_ceiling: g.risk_ceiling ?? 3,
        preauthorized_actions: g.preauthorized_actions ?? ["issues.create", "issues.batch_create", "browser.issues.create_via_form"],
        limits: g.limits ?? { max_operations: null, max_items_per_operation: null, max_concurrent_operations: null },
        expires_at: g.expires_at ?? new Date(Date.now() + 3600_000).toISOString(),
      });
    },
    async task(grant, checks, scope, principal = AGENT) {
      return coordinator.openTask(principal, {
        protocol_version: PROTOCOL_VERSION,
        goal: "integration test task",
        grant_id: grant.id,
        scope: scope ?? { actions: ["issues.*", "cli.*", "browser.*"], resources: ["issue://issue-tracker/*", "workspace://*", "browser://issue-tracker/*"] },
        required_checks: checks,
      });
    },
    async restartCoordinator() {
      coordinator = makeCoordinator();
      return coordinator;
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await registry.closeAll();
      await journal.close().catch(() => {});
      await fixture.close().catch(() => {});
      await journalDb.drop().catch(() => {});
      await fixtureDb.drop().catch(() => {});
    },
  };
  return h;
}

export function ownerCheck(owner: string, target = "issue://issue-tracker/issues/{result.id}", over: Partial<Check> = {}): Check {
  return {
    id: "owner_matches",
    method: "read_back",
    verifier_id: "http.readback",
    target,
    predicate: { op: "eq", path: "/owner", value: owner },
    freshness: { max_age_seconds: 3600 },
    deadline_seconds: 10,
    ...over,
  };
}

export function key(label = "k"): string {
  return `${label}-${randomBytes(8).toString("hex")}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
