// Layer B: the CI-failure workflow against real GitHub, on an owner-approved dedicated demo
// repository, through the same test-only fault proxy. Bounded set: normal, response lost,
// crash after submission (VAP agent; optionally the careful no-VAP agent).
//
//   VAP_GITHUB_DEMO_AUTHORIZED=1 VAP_GITHUB_REPOSITORY=owner/repo \
//   VAP_GITHUB_APP_ID=... VAP_GITHUB_APP_INSTALLATION_ID=... VAP_GITHUB_APP_PRIVATE_KEY=... \
//   VAP_TEST_ADMIN_URL=postgres://... node demo/ci-failure/run-github.ts [--runs 1] [--out reports]
//
// The three GitHub App values come from a secret store at run time (Cloud Build availableSecrets
// in infra/gcp/cloudbuild.demo-github.yaml); they are never written to files or logs. Every issue
// created is recorded in github-resources.json for the cleanup procedure; nothing is closed here.
import "../../scripts/cloud-guard.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { GithubAdapter } from "@verified-action-protocol/adapters";
import { demoToken, VapClient } from "@verified-action-protocol/sdk";
import { AgentCrash, runCarefulAgent, runVapAgent } from "./lib/agents.ts";
import type { AgentEnv, AgentReport } from "./lib/agents.ts";
import { startFaultProxy } from "./lib/fault-proxy.ts";
import type { FaultRule } from "./lib/fault-proxy.ts";
import { runTests } from "./lib/run-tests.ts";
import { createVapRuntime, RUNTIME_ROOT } from "./lib/runtime.ts";
import { issueContentValid } from "./lib/scenarios.ts";
import { deriveWorkflowId } from "./lib/workflow.ts";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const RUNS = Math.min(Number(opt("runs", "1")), 3);
const OUT = opt("out", process.env.VAP_REPORT_DIR ?? "reports");
const WITH_BASELINE = args.includes("--with-careful");
const COMMIT = process.env.COMMIT_SHA && /^[0-9a-f]{40}$/.test(process.env.COMMIT_SHA) ? process.env.COMMIT_SHA : null;

function blocked(reason: string): never {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "ci-demo-github-status.json"), JSON.stringify({ status: "blocked", reason, generated_at: new Date().toISOString() }, null, 2));
  process.stdout.write(`BLOCKED: ${reason}\n`);
  process.exit(0);
}

if (process.env.VAP_GITHUB_DEMO_AUTHORIZED !== "1") blocked("real-GitHub runs need explicit owner authorization (VAP_GITHUB_DEMO_AUTHORIZED=1) for a dedicated demo repository");
const REPOSITORY = process.env.VAP_GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPOSITORY)) blocked("VAP_GITHUB_REPOSITORY (owner/repo of the dedicated demo repository) is not set");
for (const v of ["VAP_GITHUB_APP_ID", "VAP_GITHUB_APP_INSTALLATION_ID", "VAP_GITHUB_APP_PRIVATE_KEY"]) if (!process.env[v]) blocked(`${v} is not provided by the secret store`);
if (!COMMIT) blocked("COMMIT_SHA must be the 40-character commit under test");
const AUTHOR = process.env.VAP_GITHUB_AUTHOR_LOGIN ?? "";
if (!/^[A-Za-z0-9_-]{1,50}\[bot\]$/.test(AUTHOR)) blocked("VAP_GITHUB_AUTHOR_LOGIN must be the GitHub App's bot login (<app-slug>[bot])");
// Resource limit: the run stops before creating more issues than the owner allowed.
const MAX_ISSUES = Number(process.env.VAP_GITHUB_MAX_ISSUES ?? "0");
if (!Number.isInteger(MAX_ISSUES) || MAX_ISSUES < 1 || MAX_ISSUES > 20) blocked("VAP_GITHUB_MAX_ISSUES (owner-approved cap on created issues, 1-20) is not set");

const SCHEDULES: { id: string; rules: FaultRule[]; crash: boolean }[] = [
  { id: "G1-normal", rules: [], crash: false },
  { id: "G2-response-lost", rules: [{ match: "create_issue", action: "drop_response_after_commit" }], crash: false },
  { id: "G3-crash-after-submit", rules: [{ match: "create_issue", action: "hold_response_ms", holdMs: 2000 }], crash: true },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const tests = await runTests();
  if (tests.failed !== 1) throw new Error("sample project must have exactly one failing test");
  const appEnv: Record<string, string> = { VAP_GITHUB_APP_ID: process.env.VAP_GITHUB_APP_ID!, VAP_GITHUB_APP_INSTALLATION_ID: process.env.VAP_GITHUB_APP_INSTALLATION_ID!, VAP_GITHUB_APP_PRIVATE_KEY: process.env.VAP_GITHUB_APP_PRIVATE_KEY! };
  if (process.env.VAP_GITHUB_AUTHOR_LOGIN) appEnv.VAP_GITHUB_AUTHOR_LOGIN = process.env.VAP_GITHUB_AUTHOR_LOGIN;
  // Evaluator's own reader: direct to GitHub, no proxy, same app installation (read paths only).
  const reader = new GithubAdapter({ id: "github.evaluator", api_base_url: "https://api.github.com", repository: REPOSITORY, auth: { type: "github_app", app_id_env: "VAP_GITHUB_APP_ID", installation_id_env: "VAP_GITHUB_APP_INSTALLATION_ID", private_key_env: "VAP_GITHUB_APP_PRIVATE_KEY" }, lookup_max_pages: 3, author_login: AUTHOR }, { env: appEnv });
  const resources: { workflow_id: string; issue_number: number; html_url: string; scenario: string; condition: string }[] = [];
  const results: Record<string, unknown>[] = [];
  const build = process.env.BUILD_ID ?? `manual-${Date.now()}`;

  const planned = SCHEDULES.length * RUNS * (WITH_BASELINE ? 2 : 1);
  if (planned > MAX_ISSUES) blocked(`this run would create up to ${planned} issues, above VAP_GITHUB_MAX_ISSUES=${MAX_ISSUES}; lower --runs or raise the owner-approved cap`);
  for (const s of SCHEDULES) {
    for (let run = 1; run <= RUNS; run++) {
      for (const condition of WITH_BASELINE ? ["vap", "careful"] : ["vap"]) {
        if (resources.length >= MAX_ISSUES) throw new Error("issue cap reached; stopping before any further create");
        const facts = { repository: "vap-demo/sample-project", commit: COMMIT!, buildEvent: `${build}/${s.id}/${condition}/run-${run}` };
        const wf = deriveWorkflowId(facts);
        const proxy = await startFaultProxy({ upstream: "https://api.github.com", schedule: s.rules });
        const name = `vapgh_${randomBytes(6).toString("hex")}`;
        const admin = new pg.Client({ connectionString: process.env.VAP_TEST_ADMIN_URL });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${name}`);
        await admin.end();
        const dbUrl = new URL(process.env.VAP_TEST_ADMIN_URL!);
        dbUrl.pathname = `/${name}`;
        const runtime =
          condition === "vap"
            ? await createVapRuntime({ databaseUrl: dbUrl.toString(), digestKey: randomBytes(24).toString("hex"), githubApiBaseUrl: proxy.url, githubRepository: REPOSITORY, env: { ...appEnv, VAP_ADAPTERS_CONFIG: path.join(RUNTIME_ROOT, "examples/config/adapters.ci-demo.github.json") } })
            : null;
        const reports: AgentReport[] = [];
        const started = Date.now();
        try {
          let grant = null;
          if (runtime) {
            await runtime.start();
            grant = await new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-operator") }).createGrant({
              principal: "demo-agent",
              allowed_actions: ["github.issues.create_ci_failure"],
              allowed_targets: [`github://${REPOSITORY}/*`],
              risk_ceiling: 3,
              preauthorized_actions: [],
              limits: { max_operations: 3, max_items_per_operation: 1, max_concurrent_operations: 1 },
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            });
          }
          const go = (signal: AbortSignal) => {
            const env: AgentEnv = { facts, repository: REPOSITORY, deadlineMs: Date.now() + 90_000, signal, log: (l) => process.stdout.write(`[${s.id} ${condition}] ${l}\n`) };
            return runtime ? runVapAgent(env, { apiUrl: runtime.apiUrl, grant: grant!, approve: true }) : runCarefulAgent(env, proxy.url);
          };
          if (s.crash) {
            const ac = new AbortController();
            const crash: { done: Promise<void> | null } = { done: null };
            proxy.onHold(() => {
              crash.done ??= (async () => {
                ac.abort();
                if (runtime) await runtime.crash();
              })();
            });
            const r1 = await go(ac.signal).catch((e) => (e instanceof AgentCrash || ac.signal.aborted ? null : Promise.reject(e)));
            if (r1) reports.push(r1);
            if (crash.done) {
              await crash.done;
              if (runtime) await runtime.start();
              reports.push(await go(new AbortController().signal));
            }
          } else reports.push(await go(new AbortController().signal));
        } finally {
          await runtime?.stop().catch(() => {});
          await proxy.close();
          const a = new pg.Client({ connectionString: process.env.VAP_TEST_ADMIN_URL });
          await a.connect();
          await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          await a.end();
        }
        // Evaluator: proxy truth plus authoritative GitHub reads after a settling delay.
        const truth = proxy.groundTruth().filter((r) => r.kind === "create_issue" && r.upstream_status === 201);
        for (const t of truth) if (t.issue_number && t.html_url) resources.push({ workflow_id: wf, issue_number: t.issue_number, html_url: t.html_url, scenario: s.id, condition });
        await new Promise((r) => setTimeout(r, 5000));
        const scan = await reader.findByMarker(wf, new Date(started - 600_000).toISOString(), AbortSignal.timeout(30_000));
        const final = reports[reports.length - 1];
        const issueBodies = scan.matches.map((m) => m.body ?? "");
        const valid = issueBodies.length === 1 && issueContentValid(issueBodies[0], wf, COMMIT!, tests.failures[0].name);
        results.push({
          scenario: s.id,
          condition,
          run,
          workflow_id: wf,
          claim: final?.claim ?? "none",
          issue_url: final?.issue_url ?? null,
          creates_accepted: truth.length,
          replies_delivered: proxy.groundTruth().filter((r) => r.kind === "create_issue" && r.delivered_to_client).length,
          matching_issues_visible: scan.matches.length,
          content_valid: valid,
          correct: final !== undefined && (final.claim === "created" || final.claim === "already_exists") && scan.matches.length === 1 && truth.length === 1 && valid,
          wall_ms: Date.now() - started,
        });
        process.stdout.write(`RESULT ${JSON.stringify(results[results.length - 1])}\n`);
      }
    }
  }
  writeFileSync(path.join(OUT, "ci-demo-github-results.json"), JSON.stringify({ status: "ran", repository: REPOSITORY, commit: COMMIT, build, results }, null, 2));
  writeFileSync(path.join(OUT, "github-resources.json"), JSON.stringify({ repository: REPOSITORY, created_issues: resources, cleanup: "see docs/demo/ci-failure-cleanup.md; issues are left open until cleanup is authorized" }, null, 2));
}

main().catch((e) => {
  process.stderr.write(`github demo failed: ${(e as Error).message}\n`);
  process.exit(1);
});
