// Runs the custom-action tutorial (docs/tutorial-custom-http-action.md) end to end in the cloud:
// starts the synthetic issue tracker and a VAP runtime (API + worker processes) loaded with YOUR
// adapter configuration, then sends exactly the HTTP requests the tutorial shows and checks the
// verified outcome. Writes reports/tutorial-transcript.md.
//
//   bash scripts/vap-cloud.sh tutorial [--config examples/config/adapters.tutorial.json]
//   (in the build: node scripts/tutorial-run.ts --config <path relative to the repository root>)
import "./cloud-guard.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFixture } from "@verified-action-protocol/fixture-issue-tracker";
import { createDatabase, ROOT } from "../tests/helpers/harness.ts";
import { createVapRuntime } from "../demo/ci-failure/lib/runtime.ts";

const args = process.argv.slice(2);
const configArg = args.includes("--config") ? args[args.indexOf("--config") + 1] : "examples/config/adapters.tutorial.json";
const CONFIG = path.resolve(ROOT, configArg);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : "reports";
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  process.stdout.write(s + "\n");
};

async function call(apiUrl: string, who: string, method: string, p: string, body?: unknown): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(apiUrl + p, {
    method,
    headers: { authorization: `Bearer demo:${who}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  say(`${method} ${p} (as ${who}) -> HTTP ${res.status}`);
  if (res.status >= 400) say(`  error: ${JSON.stringify(json?.error ?? json).slice(0, 400)}`);
  return { status: res.status, headers: res.headers, json };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  say(`# Custom-action tutorial run`);
  say(`config: ${configArg}`);
  const fixtureDb = await createDatabase("tutf");
  const journalDb = await createDatabase("tutj");
  const fixture = await startFixture({ databaseUrl: fixtureDb.url, port: 0 });
  const runtime = await createVapRuntime({
    databaseUrl: journalDb.url,
    digestKey: randomBytes(24).toString("hex"),
    githubApiBaseUrl: "http://127.0.0.1:9",
    githubRepository: "unused/unused",
    env: { VAP_ADAPTERS_CONFIG: CONFIG, VAP_CONNECTOR_ISSUE_TRACKER_ORIGIN: fixture.url },
    log: (l) => (/error|fatal|invalid/i.test(l) ? say(`  runtime: ${l.slice(0, 300)}`) : undefined),
  });
  let ok = false;
  try {
    await runtime.start();
    const api = runtime.apiUrl;
    // The tutorial needs an existing issue; the fixture creates one.
    const seed = await fetch(`${fixture.url}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Tutorial issue", owner: "alice" }) });
    const issueId = String(((await seed.json()) as { id: string }).id);
    say(`seeded fixture issue ${issueId}`);

    const actions = await call(api, "demo-agent", "GET", "/v1/actions");
    const listed = (actions.json?.actions ?? []).some((a: { action: { id: string } }) => a.action.id === "issues.set_status");
    say(`issues.set_status is ${listed ? "registered" : "NOT registered"} in the action catalog`);

    const grant = await call(api, "demo-operator", "POST", "/v1/operator/grants", {
      protocol_version: "0.1",
      principal: "demo-agent",
      allowed_actions: ["issues.*"],
      allowed_targets: ["issue://issue-tracker/*"],
      risk_ceiling: 1,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const task = await call(api, "demo-agent", "POST", "/v1/tasks", {
      protocol_version: "0.1",
      goal: `Move issue ${issueId} to in_progress`,
      grant_id: grant.json?.id,
      scope: { actions: ["issues.set_status"], resources: ["issue://issue-tracker/issues/*"] },
      required_checks: [
        {
          id: "status_is_in_progress",
          method: "read_back",
          verifier_id: "http.readback",
          target: `issue://issue-tracker/issues/${issueId}`,
          predicate: { op: "eq", path: "/status", value: "in_progress" },
          freshness: { max_age_seconds: 3600 },
          deadline_seconds: 10,
        },
      ],
    });
    const plan = await call(api, "demo-agent", "POST", "/v1/plans", { protocol_version: "0.1", task_id: task.json?.id, action_id: "issues.set_status", arguments: { issue_id: issueId, status: "in_progress" } });
    say(`  plan status ${plan.json?.status}, risk tier ${plan.json?.risk_tier}`);
    const key = `set-${issueId}-in-progress-1`;
    const op = await call(api, "demo-agent", "POST", "/v1/operations", { protocol_version: "0.1", plan_id: plan.json?.id, request_key: key });
    const opId = op.json?.id as string;
    let receipt: any = null;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${api}/v1/operations/${opId}/receipt`, { headers: { authorization: "Bearer demo:demo-agent" } });
      receipt = await r.json();
      if (receipt.execution_status !== "queued" && receipt.execution_status !== "running" && receipt.verification_status !== "pending") break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    say(`GET /v1/operations/${opId}/receipt -> execution_status ${receipt.execution_status}, verification_status ${receipt.verification_status}, outcome ${receipt.outcome}`);
    const outcome = await call(api, "demo-agent", "GET", `/v1/tasks/${task.json?.id}/outcome`);
    say(`  verified_complete: ${outcome.json?.verified_complete}`);
    const replay = await call(api, "demo-agent", "POST", "/v1/operations", { protocol_version: "0.1", plan_id: plan.json?.id, request_key: key });
    say(`  repeat with the same request key returns operation ${replay.json?.id} (idempotent-replay: ${replay.headers.get("idempotent-replay")})`);
    ok = listed && receipt.outcome === "verified" && outcome.json?.verified_complete === true && replay.json?.id === opId && replay.headers.get("idempotent-replay") === "true";
  } finally {
    await runtime.stop().catch(() => {});
    await fixture.close().catch(() => {});
    await journalDb.drop().catch(() => {});
    await fixtureDb.drop().catch(() => {});
  }
  say(ok ? "RESULT: the custom action ran and was verified from saved state" : "RESULT: NOT ACHIEVED");
  writeFileSync(path.join(OUT, "tutorial-transcript.md"), "```text\n" + lines.join("\n") + "\n```\n");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`tutorial run failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
